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
}
