//! Per-model context-window registry.
//!
//! The frontend meter and the backend send path must agree on how big a
//! model's context window is. This table is the backend half; `src/lib/
//! contextWindow.ts` mirrors it for the meter. Until this table existed every
//! cloud/harness model was shown (and would have been gated at) a flat 500k
//! — a 200k-window Claude model therefore showed ~40% when actually full and
//! no threshold could ever fire before a real overflow.
//!
//! Matching is by lowercase substring against the model id, most-specific
//! first (an id like "gpt-4.1-mini" must hit the 1M rule, not the 128k
//! "gpt-4" one). Ids this table doesn't recognize fall back to
//! [`DEFAULT_CLOUD_WINDOW`]; OpenRouter sessions additionally refine the
//! figure live from their public models endpoint (frontend only — that
//! endpoint needs no key, and the send path only needs a sane floor).

/// Fallback window for model ids the registry doesn't recognize. Same figure
/// the frontend's `API_CONTEXT_WINDOW` uses.
pub const DEFAULT_CLOUD_WINDOW: u32 = 500_000;

/// `(substring of the model id, context window in tokens)`, most-specific
/// first. Windows are the providers' standard (non-beta) limits: Anthropic
/// Claude 200k, GPT-5 family 400k, GPT-4.1 1M, GPT-4o 128k, Gemini 1M,
/// o-series 200k, DeepSeek 128k, Qwen/Kimi/Llama-3/Grok-3/Mistral 128k-class,
/// Grok-4 256k, GLM-5 200k.
const RULES: &[(&str, u32)] = &[
    // Anthropic — every production Claude ships a 200k window.
    ("claude", 200_000),
    // OpenAI — most-specific first: "gpt-4.1" must win over "gpt-4".
    ("gpt-5", 400_000),
    ("gpt-4.1", 1_000_000),
    ("o1-mini", 128_000),
    ("o3", 200_000),
    ("o4-mini", 200_000),
    ("o1", 200_000),
    ("gpt-4o", 128_000),
    ("gpt-4", 128_000),
    // Google
    ("gemini", 1_000_000),
    // xAI
    ("grok-4", 256_000),
    ("grok", 131_072),
    // DeepSeek
    ("deepseek", 128_000),
    // Qwen / Alibaba
    ("qwen", 131_072),
    // Moonshot
    ("kimi", 256_000),
    // Meta
    ("llama-4", 1_000_000),
    ("llama-3", 131_072),
    // Mistral
    ("mistral", 131_072),
    // Zhipu
    ("glm-5", 200_000),
    ("glm", 128_000),
    // Cohere
    ("command-a", 256_000),
    ("command", 128_000),
];

/// Look up the standard context window for a model id. Substring matching
/// (not exact) so dated/directed variants — "claude-sonnet-4-5-20250929",
/// "openai/gpt-5-mini", harness-reported ids — resolve without enumerating
/// every alias. Returns `None` for unknown ids so callers can distinguish
/// "known window" from "registry default".
pub fn window_for_model(model: &str) -> Option<u32> {
    let m = model.trim().to_ascii_lowercase();
    if m.is_empty() {
        return None;
    }
    RULES
        .iter()
        .find(|(needle, _)| m.contains(needle))
        .map(|(_, window)| *window)
}

/// Registry window with the flat fallback applied — the figure the send path
/// and breakdowns use for every cloud/harness model id.
pub fn cloud_window_for_model(model: &str) -> u32 {
    window_for_model(model).unwrap_or(DEFAULT_CLOUD_WINDOW)
}

/// The user's context-limit override (`chat.cloud.context_limit`): a cap in
/// tokens applied ON TOP of whatever the model advertises. 0/absent = no
/// override. This is how a user runs a 1M-window model at, say, 200k —
/// either to control cost or because a remapped relay backend actually
/// serves a smaller window than the model id suggests.
pub fn load_context_limit_override(conn: &rusqlite::Connection) -> Option<u32> {
    let raw = crate::db::get_setting(conn, "chat.cloud.context_limit").ok().flatten()?;
    let v = raw.trim().parse::<u64>().ok()?;
    if v > 0 {
        u32::try_from(v).ok()
    } else {
        None
    }
}

/// The EFFECTIVE window for a cloud/harness model: the dynamic-or-registry
/// window, capped by the user's override when one is set. This single
/// number drives both the meter and the compaction trigger, so the two can
/// never disagree about how much room is left.
pub fn effective_cloud_window(model: &str, override_limit: Option<u32>) -> u32 {
    match override_limit {
        Some(cap) => cloud_window_for_model(model).min(cap),
        None => cloud_window_for_model(model),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_families_resolve_to_their_standard_window() {
        assert_eq!(window_for_model("claude-sonnet-4-5-20250929"), Some(200_000));
        assert_eq!(window_for_model("claude-opus-4-8"), Some(200_000));
        assert_eq!(window_for_model("gpt-5"), Some(400_000));
        assert_eq!(window_for_model("openai/gpt-5-mini"), Some(400_000));
        assert_eq!(window_for_model("gpt-4.1-mini"), Some(1_000_000));
        assert_eq!(window_for_model("gpt-4o"), Some(128_000));
        assert_eq!(window_for_model("o3"), Some(200_000));
        assert_eq!(window_for_model("gemini-2.5-pro"), Some(1_000_000));
        assert_eq!(window_for_model("deepseek-v4-pro"), Some(128_000));
        assert_eq!(window_for_model("grok-4"), Some(256_000));
        assert_eq!(window_for_model("kimi-k3"), Some(256_000));
    }

    #[test]
    fn most_specific_rule_wins() {
        // "gpt-4.1" must not be swallowed by the broader "gpt-4" 128k rule…
        assert_ne!(window_for_model("gpt-4.1"), window_for_model("gpt-4o"));
        // …and "o1-mini" must not be swallowed by the "o1" 200k rule.
        assert_eq!(window_for_model("o1-mini"), Some(128_000));
        assert_eq!(window_for_model("o1"), Some(200_000));
    }

    #[test]
    fn unknown_ids_fall_back() {
        assert_eq!(window_for_model("totally-unknown-model"), None);
        assert_eq!(window_for_model(""), None);
        assert_eq!(window_for_model("   "), None);
        assert_eq!(cloud_window_for_model("totally-unknown-model"), DEFAULT_CLOUD_WINDOW);
    }

    #[test]
    fn matching_is_case_and_prefix_insensitive() {
        assert_eq!(window_for_model("Claude-Sonnet-4-5"), Some(200_000));
        assert_eq!(window_for_model("anthropic/claude-opus-4-8"), Some(200_000));
        assert_eq!(window_for_model("GPT-5-CODEX"), Some(400_000));
    }

    #[test]
    fn effective_window_applies_the_override_cap() {
        // No override → registry value.
        assert_eq!(effective_cloud_window("claude-sonnet-4-5", None), 200_000);
        // Override below the model's window caps it.
        assert_eq!(effective_cloud_window("claude-sonnet-4-5", Some(100_000)), 100_000);
        // Override ABOVE the model's window does not raise it — a cap can
        // only shrink, never invent headroom the provider doesn't offer.
        assert_eq!(effective_cloud_window("claude-sonnet-4-5", Some(400_000)), 200_000);
        // Unknown model: fallback gets capped too.
        assert_eq!(effective_cloud_window("unknown-model", Some(50_000)), 50_000);
        assert_eq!(effective_cloud_window("unknown-model", None), DEFAULT_CLOUD_WINDOW);
    }

    #[test]
    fn context_limit_override_parses_and_rejects_zero_or_garbage() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        assert_eq!(load_context_limit_override(&conn), None);
        crate::db::set_setting(&conn, "chat.cloud.context_limit", "200000").unwrap();
        assert_eq!(load_context_limit_override(&conn), Some(200_000));
        // 0 = auto (no override).
        crate::db::set_setting(&conn, "chat.cloud.context_limit", "0").unwrap();
        assert_eq!(load_context_limit_override(&conn), None);
        crate::db::set_setting(&conn, "chat.cloud.context_limit", "garbage").unwrap();
        assert_eq!(load_context_limit_override(&conn), None);
    }
}
