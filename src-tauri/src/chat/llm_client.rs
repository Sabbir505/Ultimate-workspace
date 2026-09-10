//! Shared plumbing for one-shot (non-streaming) LLM calls: the B-10 client,
//! per-provider base-URL resolution, and the single provider dispatch that
//! replaces the per-command `match provider_str` blocks (titles, commit
//! messages, diff reviews, PR bodies, memory extraction).

/// B-10: one-shot JSON calls carry a total timeout so a wedged endpoint
/// bounds the async command instead of hanging it forever.
pub(crate) fn oneshot_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))
}

/// Base URL for `provider`: managed providers (openai / openrouter /
/// anthropic) fall back to their defaults; the compatible/local providers
/// have no sensible default, so a configured base is REQUIRED (None).
/// Unknown providers resolve to None.
pub(crate) fn resolve_base_url<'a>(provider: &str, base_url: Option<&'a str>) -> Option<&'a str> {
    match provider {
        "openai" => Some(base_url.unwrap_or(crate::chat::providers::OpenAIProvider::DEFAULT_BASE)),
        "openrouter" => {
            Some(base_url.unwrap_or(crate::chat::providers::OpenRouterProvider::DEFAULT_BASE))
        }
        "anthropic" => {
            Some(base_url.unwrap_or(crate::chat::providers::AnthropicProvider::DEFAULT_BASE))
        }
        "openai_compatible" | "local_gguf" | "anthropic_compatible" => base_url,
        _ => None,
    }
}

/// One-shot (non-streaming) OpenAI-style completion returning the message text.
pub(crate) async fn openai_oneshot(
    client: &reqwest::Client,
    api_key: &str,
    base: &str,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let url = format!("{base}/v1/chat/completions");
    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    });
    let resp = crate::util::checked_send(
        client
            .post(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("content-type", "application/json")
            .json(&body),
        500,
    )
    .await?;
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

/// One-shot (non-streaming) Anthropic-style completion returning the text.
/// `max_tokens` is required by Anthropic's API; callers choose it (titles: 32,
/// commit messages: 64 for subject + body, diff reviews: 2048).
pub(crate) async fn anthropic_oneshot(
    client: &reqwest::Client,
    api_key: &str,
    base: &str,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let url = format!("{base}/v1/messages");
    let body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "stream": false,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    });
    let resp = crate::util::checked_send(
        client
            .post(&url)
            .header("x-api-key", api_key)
            .header(
                "anthropic-version",
                crate::chat::providers::ANTHROPIC_API_VERSION,
            )
            .header("content-type", "application/json")
            .json(&body),
        500,
    )
    .await?;
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["content"][0]["text"].as_str().unwrap_or("").to_string())
}

/// Dispatch one provider-agnostic non-streaming completion.
///
/// - `Err` — transport/HTTP failure (propagates to the caller's user).
/// - `Ok(None)` — unknown provider, or a compatible/local provider with no
///   configured base URL. Callers decide whether that skips silently or is
///   an error (memory extraction promotes it to `Err`; the generators return
///   `Ok(None)` so the user keeps the existing title/subject).
///
/// NOTE: the assistant-panel one-shot in `chat/mod.rs` deliberately does NOT
/// route through here — it treats `anthropic_compatible` as managed (falls
/// back to the default base) and errors on a missing base for the
/// openai-compatible set instead of skipping.
pub(crate) async fn oneshot(
    provider: &str,
    client: &reqwest::Client,
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    system: &str,
    user: &str,
    anthropic_max_tokens: u32,
) -> Result<Option<String>, String> {
    let Some(base) = resolve_base_url(provider, base_url) else {
        return Ok(None);
    };
    match provider {
        "openai" | "openrouter" | "openai_compatible" | "local_gguf" => {
            openai_oneshot(client, api_key, base, model, system, user)
                .await
                .map(Some)
        }
        "anthropic" | "anthropic_compatible" => anthropic_oneshot(
            client,
            api_key,
            base,
            model,
            system,
            user,
            anthropic_max_tokens,
        )
        .await
        .map(Some),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::providers::{AnthropicProvider, OpenAIProvider, OpenRouterProvider};

    #[test]
    fn managed_providers_fall_back_to_default_base() {
        assert_eq!(
            resolve_base_url("openai", None),
            Some(OpenAIProvider::DEFAULT_BASE)
        );
        assert_eq!(
            resolve_base_url("openrouter", None),
            Some(OpenRouterProvider::DEFAULT_BASE)
        );
        assert_eq!(
            resolve_base_url("anthropic", None),
            Some(AnthropicProvider::DEFAULT_BASE)
        );
        // An explicit base always wins over the default.
        assert_eq!(
            resolve_base_url("openai", Some("http://x")),
            Some("http://x")
        );
    }

    #[test]
    fn compatible_providers_require_an_explicit_base() {
        for p in ["openai_compatible", "local_gguf", "anthropic_compatible"] {
            assert_eq!(resolve_base_url(p, None), None, "{p}");
            // Blank-filtering is the caller's job (the generators pre-filter);
            // resolve only treats absence as missing.
            assert_eq!(resolve_base_url(p, Some("  ")), Some("  "), "{p}");
            assert_eq!(
                resolve_base_url(p, Some("http://lan:8080")),
                Some("http://lan:8080"),
                "{p}"
            );
        }
    }

    #[test]
    fn unknown_providers_resolve_to_none() {
        assert_eq!(
            resolve_base_url("harness:claude_code", Some("http://x")),
            None
        );
        assert_eq!(resolve_base_url("nonsense", None), None);
    }

    #[test]
    fn thinking_budget_stays_within_anthropic_bounds() {
        // Property: budget >= 1024, strictly < max_tokens, and max_tokens -
        // budget leaves >= 1024 for the visible answer. (max_tokens < 2048
        // panics the clamp — both call sites floor the cap to >= 3072 first,
        // the E-3 guard.)
        for mt in [2048i64, 3072, 4096, 8192, 32_768] {
            let b = crate::chat::providers::anthropic_thinking_budget(mt);
            assert!(b >= 1024, "mt={mt} budget={b}");
            assert!(b < mt, "mt={mt} budget={b}");
            assert!(mt - b >= 1024, "mt={mt} budget={b}");
        }
        assert_eq!(
            crate::chat::providers::anthropic_thinking_budget(4096),
            3072
        );
    }
}
