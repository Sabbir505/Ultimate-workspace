//! Context-overflow error classification.
//!
//! A provider rejecting a request because it exceeds the model's context
//! window is not "any 400": it is recoverable (compact the history and retry)
//! and deserves its own UX instead of a raw provider error blob in the
//! banner. Every error string that flows out of the send path — built-in
//! chat (`chat/mod.rs` turns) and harness sessions (`agent_sessions.rs`) —
//! is matched against the markers below and, on a hit, emitted with
//! `code = Some("context_overflow")` on `chat:error`. The frontend keys its
//! overflow copy off that code.
//!
//! Matching is deliberately fuzzy substring (lowercased): the strings arrive
//! verbatim from five different providers and a remapped relay proxy, each
//! with its own phrasing, and a stricter match would silently strand users
//! on the raw banner.

/// `chat:error` code for "the request exceeded the model's context window".
pub const CODE_CONTEXT_OVERFLOW: &str = "context_overflow";

/// Substrings (lowercased) that identify a context-overflow rejection across
/// the providers Relay talks to:
/// - Anthropic: "prompt is too long: N tokens > M maximum"
/// - OpenAI: "This model's maximum context length is N tokens", "input length
///   and `max_tokens` exceed context limit", "Please reduce the length of the
///   messages"
/// - OpenAI/OpenRouter error code: "context_length_exceeded"
/// - llama-server (local): "exceed_context_size_error"
/// - Google: "input token count ... exceeds the maximum number of tokens"
const OVERFLOW_MARKERS: &[&str] = &[
    "prompt is too long",
    "input length and `max_tokens` exceed context limit",
    "context_length_exceeded",
    "exceed_context_size_error",
    "maximum context length",
    "reduce the length of the messages",
    "input token count exceeds",
    "too many input tokens",
    "exceeds the context window",
    "request too large",
    "http 413",
];

/// Classify a backend error string. Returns the `chat:error` code to emit,
/// or `None` when the error has no special handling.
pub fn classify_error(message: &str) -> Option<&'static str> {
    let m = message.to_ascii_lowercase();
    if OVERFLOW_MARKERS.iter().any(|k| m.contains(k)) {
        Some(CODE_CONTEXT_OVERFLOW)
    } else {
        None
    }
}

// ---- Pre-stream failure classification (auto fail-over) --------------------
//
// The auto router (chat/auto_router.rs) fails a turn over to the next
// candidate when the FIRST candidate fails before any token streamed. The
// send path produces error strings from two very different moments:
//
// - PRE-STREAM: "HTTP {status}: {body}" (non-2xx response headers),
//   "request failed: …" (connection error), "request timed out waiting for
//   response headers (60s)". Nothing reached the user — safe to re-route.
// - MID-STREAM: "stream stalled: …", "stream read error: …", provider error
//   events after the 200 OK. Tokens may already be on screen and partially
//   persisted — NEVER silently re-route these (the research doc's rule).
//
// Classifying by message prefix is deliberately consistent with how the
// stream round functions build these strings (streaming.rs).

/// Why a pre-stream attempt failed — drives health bookkeeping
/// (chat/model_health.rs) and the fail-over decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailureKind {
    /// 401/403 — the key is rejected. Auto skips this provider; the user
    /// must fix the key (surfaced, never hidden).
    Auth,
    /// 402 / spend-cap — the account is out of credit. Provider skipped
    /// until revalidated; other providers take over.
    Payment,
    /// 429 — rate limited. Honor retry-after when the body carries one;
    /// otherwise a short default cooldown.
    RateLimit { retry_after_secs: Option<i64> },
    /// 5xx — provider-side trouble. Short cooldown, then fail over.
    Server,
    /// Connection refused / DNS / header timeout — endpoint unreachable.
    Network,
    /// 404 / "model not found" — this MODEL is gone (deprecated id),
    /// provider may be fine.
    ModelNotFound,
}

impl FailureKind {
    /// Whether switching to the next auto candidate can plausibly fix this.
    /// Auth/payment fail over too (disclosed — a broken key must not wedge a
    /// chat when another provider works), but their health marks keep the
    /// provider out of future turns until revalidated.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            FailureKind::RateLimit { .. }
                | FailureKind::Server
                | FailureKind::Network
                | FailureKind::Payment
                | FailureKind::Auth
                | FailureKind::ModelNotFound
        )
    }
}

/// A classified PRE-STREAM failure: `None` means "mid-stream or unknown —
/// do not fail over".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreStreamFailure {
    pub kind: FailureKind,
    pub status: Option<u16>,
}

fn status_of(m: &str) -> Option<u16> {
    // "HTTP 429: …" — parse the status between the prefix and the colon.
    let rest = m.strip_prefix("http ")?;
    let end = rest.find(':')?;
    rest[..end].trim().parse::<u16>().ok()
}

/// Classify a send-path error string. Returns `None` for mid-stream and
/// unknown errors (never fail over on those).
pub fn classify_failure(message: &str) -> Option<PreStreamFailure> {
    let m = message.to_ascii_lowercase();
    // Pre-stream network failures: connection/transport errors that happen
    // before any byte of the response.
    if m.starts_with("request failed:") {
        return Some(PreStreamFailure { kind: FailureKind::Network, status: None });
    }
    if m.starts_with("request timed out waiting for response headers") {
        return Some(PreStreamFailure { kind: FailureKind::Network, status: None });
    }
    let status = status_of(&m)?;
    let kind = match status {
        401 | 403 => FailureKind::Auth,
        402 => FailureKind::Payment,
        // Anthropic's monthly spend-cap 429 names "enforced_spend_limit" —
        // retrying can never succeed, so it's Payment, not RateLimit.
        429 if m.contains("spend_limit") || m.contains("spend limit") => FailureKind::Payment,
        429 => FailureKind::RateLimit { retry_after_secs: parse_retry_after(&m) },
        404 => FailureKind::ModelNotFound,
        s if s >= 500 => FailureKind::Server,
        // Other 4xx = bad request shape — switching models won't fix it.
        _ => return None,
    };
    Some(PreStreamFailure { kind, status: Some(status) })
}

/// Best-effort `retry-after` scrape from an error BODY (the header is lost by
/// the time errors are strings). Accepts "retry-after: 12", "retry after 12s"
/// and "try again in 12 seconds" phrasings; caps absurd values.
fn parse_retry_after(m: &str) -> Option<i64> {
    for key in ["retry-after:", "retry after", "try again in"] {
        if let Some(idx) = m.find(key) {
            let tail = &m[idx + key.len()..];
            let num: String = tail
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(v) = num.parse::<i64>() {
                return Some(v.clamp(1, 600));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_provider_overflow_phrasings() {
        assert_eq!(
            classify_error("HTTP 400: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 250000 tokens > 200000 maximum\"}}"),
            Some(CODE_CONTEXT_OVERFLOW)
        );
        assert_eq!(
            classify_error(
                "HTTP 400: {\"error\":{\"message\":\"This model's maximum context length is 128000 tokens. However, you requested 130000 tokens\"}}"
            ),
            Some(CODE_CONTEXT_OVERFLOW)
        );
        assert_eq!(
            classify_error("HTTP 400: context_length_exceeded: reduce input"),
            Some(CODE_CONTEXT_OVERFLOW)
        );
        assert_eq!(
            classify_error("HTTP 400: {\"error\":\"exceed_context_size_error\"}"),
            Some(CODE_CONTEXT_OVERFLOW)
        );
        assert_eq!(
            classify_error("Please reduce the length of the messages or completion"),
            Some(CODE_CONTEXT_OVERFLOW)
        );
        assert_eq!(
            classify_error("input token count exceeds the maximum number of tokens allowed"),
            Some(CODE_CONTEXT_OVERFLOW)
        );
        assert_eq!(classify_error("HTTP 413: payload too large"), Some(CODE_CONTEXT_OVERFLOW));
    }

    #[test]
    fn does_not_classify_unrelated_errors() {
        assert_eq!(classify_error("HTTP 401: invalid api key"), None);
        assert_eq!(classify_error("HTTP 429: rate limit exceeded"), None);
        assert_eq!(classify_error("error sending request for url"), None);
        assert_eq!(classify_error("summarize returned 500: internal"), None);
        // "maximum" alone (not the context-length phrase) must not match.
        assert_eq!(classify_error("max_tokens must be at most 8192"), None);
    }

    fn kind_of(msg: &str) -> Option<FailureKind> {
        classify_failure(msg).map(|f| f.kind)
    }

    #[test]
    fn classifies_pre_stream_http_statuses() {
        assert_eq!(
            kind_of("HTTP 401: {\"error\":\"invalid_api_key\"}"),
            Some(FailureKind::Auth)
        );
        assert_eq!(kind_of("HTTP 402: insufficient credits"), Some(FailureKind::Payment));
        assert_eq!(
            kind_of("HTTP 429: rate limit exceeded"),
            Some(FailureKind::RateLimit { retry_after_secs: None })
        );
        // Anthropic's monthly spend-cap 429 can never succeed by retrying.
        assert_eq!(
            kind_of("HTTP 429: enforced_spend_limit_reached for org"),
            Some(FailureKind::Payment)
        );
        assert_eq!(
            kind_of("HTTP 503: service unavailable"),
            Some(FailureKind::Server)
        );
        assert_eq!(
            kind_of("HTTP 404: model claude-x-20250101 not found"),
            Some(FailureKind::ModelNotFound)
        );
        // Other 4xx: a bad request shape — no fail-over.
        assert_eq!(classify_failure("HTTP 400: invalid content field"), None);
    }

    #[test]
    fn classifies_pre_stream_transport_failures() {
        assert_eq!(
            kind_of("request failed: error sending request for url (…/v1/chat/completions)"),
            Some(FailureKind::Network)
        );
        assert_eq!(
            kind_of("request timed out waiting for response headers (60s)"),
            Some(FailureKind::Network)
        );
    }

    #[test]
    fn never_classifies_mid_stream_errors() {
        assert_eq!(classify_failure("stream stalled: no data received for 60s"), None);
        assert_eq!(classify_failure("stream read error: connection reset"), None);
        // A mid-stream provider error event (after the 200 OK) carries the
        // "provider error:" prefix — tokens may already be on screen.
        assert_eq!(classify_failure("provider error: HTTP 429: slow down"), None);
        assert_eq!(classify_failure(""), None);
    }

    #[test]
    fn parses_retry_after_from_bodies() {
        assert_eq!(
            kind_of("HTTP 429: Rate limited. Please retry after 12s."),
            Some(FailureKind::RateLimit { retry_after_secs: Some(12) })
        );
        assert_eq!(
            kind_of("HTTP 429: slow_down, try again in 30 seconds"),
            Some(FailureKind::RateLimit { retry_after_secs: Some(30) })
        );
        assert_eq!(
            kind_of("HTTP 429: Retry-After: 45"),
            Some(FailureKind::RateLimit { retry_after_secs: Some(45) })
        );
    }

    #[test]
    fn every_failure_kind_is_retryable_for_auto() {
        assert!(FailureKind::Auth.retryable());
        assert!(FailureKind::Payment.retryable());
        assert!(FailureKind::RateLimit { retry_after_secs: None }.retryable());
        assert!(FailureKind::Server.retryable());
        assert!(FailureKind::Network.retryable());
        assert!(FailureKind::ModelNotFound.retryable());
    }
}
