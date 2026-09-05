// Auto model routing (AUTO_MODEL_ROUTING_RESEARCH.md) — picks the cloud
// provider + model a turn should run on when the session is in Auto mode.
//
//! Pure decision logic lives here; the async gathering (keychain lookups,
//! settings reads, live /v1/models fetches) lives in the `send_chat_message`
//! integration (`commands.rs::gather_auto_snapshots`) and feeds snapshots in.
//!
//! v1 scope (per product decision): cloud providers ONLY — the local GGUF
//! sidecar and the harness CLIs are never auto candidates. Local routing is
//! a single-slot sidecar swap (a "load", not a connection) and CLI auth/
//! credit state is invisible to Relay, so neither is safe to route to
//! automatically yet.
//!
//! Selection is deliberately rule-based, not learned (RouterBench's finding:
//! naive routers rarely beat good rules on typical tasks). The rules, in
//! order: availability (keyed + reachable model list) → context-window fit →
//! vision capability when the turn carries images → stickiness (keep this
//! conversation on its resolved model while it stays eligible — prompt-cache
//! economics) → provider preference order (the same anthropic → openai →
//! openrouter → compatible scan `get_chat_config` uses).

/// Providers Auto may route to, in static preference order (fallback ranking
/// when stickiness doesn't decide). Mirrors get_chat_config's priority scan.
pub const AUTO_PROVIDERS: [&str; 5] = [
    "anthropic",
    "openai",
    "openrouter",
    "anthropic_compatible",
    "openai_compatible",
];

/// The send path's hardcoded per-turn cap (commands.rs `max_tokens`); the
/// resolver reserves room for it on top of the estimated prompt.
pub const MAX_RESPONSE_TOKENS: u64 = 4096;
/// Small slack so a prompt estimated right at a window's edge doesn't get
/// routed into a guaranteed overflow.
const WINDOW_SLACK_TOKENS: u64 = 512;

/// One routable model as reported by a provider's /v1/models (or its curated
/// list). `context_window: None` = the provider didn't publish one — such
/// models are never excluded for size (missing data must not become a
/// false "doesn't fit").
#[derive(Debug, Clone, PartialEq)]
pub struct ModelEntry {
    pub id: String,
    pub context_window: Option<u64>,
}

/// Everything the resolver knows about one candidate provider, gathered by
/// the caller. `models` is `Err` when the provider is configured but its
/// model list couldn't be fetched (dead endpoint, bad base_url, network) —
/// an unreachable provider is not a routable one.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderSnapshot {
    pub id: String,
    pub has_key: bool,
    /// The provider's persisted default model (`chat.<provider>.model`) —
    /// preferred within the provider when it's still eligible.
    pub preferred_model: Option<String>,
    pub models: Result<Vec<ModelEntry>, String>,
}

/// What the resolver knows about the turn being routed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AutoQuery {
    /// Conservative estimate of the whole outgoing prompt in tokens
    /// (messages + system prompt), computed by the caller.
    pub prompt_tokens: u64,
    /// The turn carries image attachments — prefer known-vision models.
    pub needs_vision: bool,
    /// (provider, model) this conversation last resolved to, when it's still
    /// on the session row (model ≠ "auto"). None for a fresh Auto chat.
    pub sticky: Option<(String, String)>,
    /// Ranking bias (chat.auto.bias setting). Balanced (the default) keeps
    /// provider-preference ranking; Economy promotes cheap/free candidates;
    /// Quality behaves like Balanced today (reserved for future quality
    /// signals — e.g. skipping :free variants when a paid twin exists).
    pub bias: Bias,
}

/// User-facing cost/quality preference for Auto ranking (Cursor's
/// Intelligence/Balance/Cost, OpenRouter's cost_tier).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Bias {
    #[default]
    Balanced,
    Quality,
    Economy,
}

impl Bias {
    pub fn from_setting(value: Option<&str>) -> Bias {
        match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
            "economy" => Bias::Economy,
            "quality" => Bias::Quality,
            _ => Bias::Balanced,
        }
    }
}

/// Coarse cost tier of a model, derived from Relay's known pricing
/// (`canonical_model_key` + `default_rates`) and the `:free` suffix
/// convention. Unknown ≠ free — unpriced models are treated as unknown and
/// never promoted over a genuinely free one in Economy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CostClass {
    Free,
    Cheap,
    Unknown,
    Standard,
    Premium,
}

pub fn cost_class_for(model_id: &str) -> CostClass {
    let id = model_id.to_ascii_lowercase();
    // OpenRouter marks free variants with a `:free` suffix.
    if id.ends_with(":free") || id.ends_with("-free") {
        return CostClass::Free;
    }
    match crate::harness_adapters::canonical_model_key(model_id)
        .and_then(crate::harness_adapters::default_rates)
    {
        // Rank on the OUTPUT rate — that's the runaway cost driver.
        Some((_, out)) if out <= 2.0 => CostClass::Cheap,
        Some((_, out)) if out <= 10.0 => CostClass::Standard,
        Some(_) => CostClass::Premium,
        None => CostClass::Unknown,
    }
}

/// One routable option in chain order — index 0 is the pick, the rest are
/// the fail-over order (consumed by the Phase-2 reliability work; v1 uses
/// index 0 only).
#[derive(Debug, Clone, PartialEq)]
pub struct AutoCandidate {
    pub provider: String,
    pub model: String,
    pub context_window: Option<u64>,
    /// Human-readable why, shown in the disclosure status line.
    pub reason: String,
}

/// Best-effort vision-capability heuristic (Continue.dev-style id sniffing —
/// providers don't publish capabilities via /v1/models). `false` does NOT
/// mean "no vision", it means "not known to have vision": when a turn needs
/// vision and nothing is known-capable, unknown models still qualify as a
/// last resort rather than failing the turn.
pub fn supports_vision(model_id: &str) -> bool {
    let id = model_id.to_ascii_lowercase();
    // Claude 3+ — all current families are multimodal.
    if id.contains("claude") {
        return true;
    }
    // OpenAI: 4o/4.1/4-turbo and the reasoning pair with vision; 3.5 and the
    // small reasoning minis don't.
    if id.contains("gpt-4o") || id.contains("gpt-4.1") || id.contains("gpt-4-turbo") {
        return true;
    }
    if id.contains("o1") && !id.contains("o1-mini") {
        return true;
    }
    if id.contains("o3") || id.contains("o4") {
        return true;
    }
    if id.contains("gpt-5") {
        return true;
    }
    // Google Gemini — vision across the board.
    if id.contains("gemini") || id.contains("gemma") {
        return true;
    }
    // xAI / Meta / Mistral / others with explicit vision variants.
    if id.contains("grok-4") || id.contains("grok-3") || id.contains("grok-2-vision") {
        return true;
    }
    for marker in ["llama-3.2-vision", "llama-4", "pixtral", "vl", "vision"] {
        if id.contains(marker) {
            return true;
        }
    }
    false
}

fn fits_context(entry: &ModelEntry, needed: u64) -> bool {
    match entry.context_window {
        Some(w) => w > needed,
        None => true,
    }
}

/// Rank one provider's eligible models; `None` when nothing survives the
/// filters. Within a provider: sticky model → provider default → list order
/// (first-party /v1/lists put the flagship first); known-vision models win
/// when the turn needs vision, unknown-vision ones form the last-resort tier.
fn best_of_provider(
    snap: &ProviderSnapshot,
    models: &[ModelEntry],
    query: &AutoQuery,
    needed: u64,
) -> Option<(ModelEntry, String)> {
    let sticky_model = query
        .sticky
        .as_ref()
        .map(|(_, m)| m.to_ascii_lowercase());
    let rank = |i: usize, m: &ModelEntry| -> (u8, u8, u8, u8, usize) {
        (
            // Vision tier: 0 = vision not needed or known-capable, 1 = unknown.
            if !query.needs_vision || supports_vision(&m.id) { 0 } else { 1 },
            // Economy: cheaper models first within the provider.
            if query.bias == Bias::Economy {
                cost_class_for(&m.id) as u8
            } else {
                0u8
            },
            match &sticky_model {
                Some(s) if *s == m.id.to_ascii_lowercase() => 0,
                _ => 1,
            },
            match snap.preferred_model.as_deref() {
                Some(p) if p.eq_ignore_ascii_case(&m.id) => 0,
                _ => 1,
            },
            i,
        )
    };
    let best = models
        .iter()
        .enumerate()
        .filter(|(_, m)| fits_context(m, needed))
        .min_by_key(|(i, m)| rank(*i, m))?;
    let entry = best.1.clone();
    let mut reason = if sticky_model.as_deref() == Some(entry.id.to_ascii_lowercase().as_str()) {
        "continuing this chat".to_string()
    } else if snap
        .preferred_model
        .as_deref()
        .map(|p| p.eq_ignore_ascii_case(&entry.id))
        .unwrap_or(false)
    {
        "provider default, fits context".to_string()
    } else {
        "fits context".to_string()
    };
    if query.needs_vision && !supports_vision(&entry.id) {
        reason.push_str(" · vision unverified");
    }
    Some((entry, reason))
}

/// Resolve the ordered candidate chain. `Ok(chain)` with at least one entry,
/// or `Err(user-facing explanation)` when nothing is routable. Never panics,
/// never touches the network — everything is in the snapshots.
pub fn resolve(
    snapshots: &[ProviderSnapshot],
    query: &AutoQuery,
) -> Result<Vec<AutoCandidate>, String> {
    let needed = query.prompt_tokens + MAX_RESPONSE_TOKENS + WINDOW_SLACK_TOKENS;

    let keyless: Vec<&str> = AUTO_PROVIDERS
        .iter()
        .filter(|p| {
            snapshots
                .iter()
                .find(|s| &s.id == **p)
                .map(|s| !s.has_key)
                .unwrap_or(true)
        })
        .copied()
        .collect();
    if keyless.len() == AUTO_PROVIDERS.len() {
        return Err(
            "Auto needs at least one cloud provider with an API key — add one in Settings → API Keys."
                .to_string(),
        );
    }

    // Per-provider best pick, in preference order. Sticky provider's pick is
    // lifted to the front of the chain afterwards.
    let mut chain: Vec<AutoCandidate> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for pid in AUTO_PROVIDERS {
        let Some(snap) = snapshots.iter().find(|s| s.id == *pid) else {
            continue;
        };
        if !snap.has_key {
            continue;
        }
        let Ok(models) = &snap.models else {
            skipped.push(format!("{} unreachable", provider_label(pid)));
            continue;
        };
        if models.is_empty() {
            skipped.push(format!("{} lists no models", provider_label(pid)));
            continue;
        }
        match best_of_provider(snap, models, query, needed) {
            Some((entry, mut reason)) => {
                let is_sticky_pick = query
                    .sticky
                    .as_ref()
                    .map(|(sp, sm)| sp == pid && sm.eq_ignore_ascii_case(&entry.id))
                    .unwrap_or(false);
                if is_sticky_pick {
                    reason = "continuing this chat".to_string();
                }
                chain.push(AutoCandidate {
                    provider: pid.to_string(),
                    model: entry.id,
                    context_window: entry.context_window,
                    reason,
                });
            }
            None => skipped.push(format!(
                "{}: no model with a large enough context window (need ≈{} tokens)",
                provider_label(pid),
                needed
            )),
        }
    }

    // Bias-driven reordering (stable — provider preference survives within
    // a cost class): Economy promotes free/cheap providers' picks; Quality
    // demotes known-free/cheap variants (weak twins) behind unknown-cost
    // frontier models; Balanced keeps provider preference.
    match query.bias {
        Bias::Economy => chain.sort_by_key(|c| cost_class_for(&c.model)),
        Bias::Quality => chain.sort_by_key(|c| match cost_class_for(&c.model) {
            CostClass::Free | CostClass::Cheap => 1,
            _ => 0,
        }),
        Bias::Balanced => {}
    }

    // Sticky pick first (cache economics — see module docs). The sticky
    // provider keeps its position in the rest of the chain.
    if let Some((sp, sm)) = &query.sticky {
        if let Some(pos) = chain
            .iter()
            .position(|c| &c.provider == sp && c.model.eq_ignore_ascii_case(sm))
        {
            let sticky = chain.remove(pos);
            chain.insert(0, sticky);
        }
    }

    if chain.is_empty() {
        let detail = if skipped.is_empty() {
            "no provider is usable right now".to_string()
        } else {
            skipped.join("; ")
        };
        return Err(format!("Auto couldn't pick a model: {detail}."));
    }
    chain.truncate(5);
    Ok(chain)
}

/// Display label for a provider id (status-line disclosure).
pub fn provider_label(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "Anthropic",
        "openai" => "OpenAI",
        "openrouter" => "OpenRouter",
        "anthropic_compatible" => "Anthropic-compatible",
        "openai_compatible" => "OpenAI-compatible",
        "local_gguf" => "Local model",
        other => Box::leak(other.to_string().into_boxed_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, window: Option<u64>) -> ModelEntry {
        ModelEntry {
            id: id.to_string(),
            context_window: window,
        }
    }

    fn snap(id: &str, has_key: bool, models: Result<Vec<ModelEntry>, String>) -> ProviderSnapshot {
        ProviderSnapshot {
            id: id.to_string(),
            has_key,
            preferred_model: None,
            models,
        }
    }

    fn query(prompt: u64) -> AutoQuery {
        AutoQuery {
            prompt_tokens: prompt,
            needs_vision: false,
            sticky: None,
            bias: Bias::Balanced,
        }
    }

    fn all_keyed(models: Vec<ModelEntry>) -> Vec<ProviderSnapshot> {
        AUTO_PROVIDERS
            .iter()
            .map(|p| snap(p, true, Ok(models.clone())))
            .collect()
    }

    #[test]
    fn prefers_providers_in_static_order() {
        let chain = resolve(&all_keyed(vec![entry("m", None)]), &query(100)).unwrap();
        assert_eq!(chain[0].provider, "anthropic");
        assert_eq!(chain[0].model, "m");
        // The chain carries fail-over candidates in preference order.
        assert_eq!(chain[1].provider, "openai");
        assert_eq!(chain.last().unwrap().provider, "openai_compatible");
    }

    #[test]
    fn keyless_providers_are_skipped() {
        let mut snaps = all_keyed(vec![entry("m", None)]);
        snaps[0] = snap("anthropic", false, Ok(vec![])); // no key
        let chain = resolve(&snaps, &query(100)).unwrap();
        assert_eq!(chain[0].provider, "openai");
        assert!(chain.iter().all(|c| c.provider != "anthropic"));
    }

    #[test]
    fn errors_helpfully_when_no_provider_has_a_key() {
        let snaps: Vec<ProviderSnapshot> = AUTO_PROVIDERS
            .iter()
            .map(|p| snap(p, false, Ok(vec![])))
            .collect();
        let err = resolve(&snaps, &query(100)).unwrap_err();
        assert!(err.contains("Settings → API Keys"), "got: {err}");
    }

    #[test]
    fn unreachable_provider_is_skipped_not_fatal() {
        let mut snaps = all_keyed(vec![entry("m", None)]);
        snaps[0] = snap("anthropic", true, Err("HTTP 503".to_string()));
        let chain = resolve(&snaps, &query(100)).unwrap();
        assert_eq!(chain[0].provider, "openai");
    }

    #[test]
    fn errors_when_every_provider_is_unreachable() {
        let snaps: Vec<ProviderSnapshot> = AUTO_PROVIDERS
            .iter()
            .map(|p| snap(p, true, Err("timeout".to_string())))
            .collect();
        let err = resolve(&snaps, &query(100)).unwrap_err();
        assert!(err.contains("couldn't pick a model"), "got: {err}");
    }

    #[test]
    fn models_too_small_for_the_prompt_are_excluded() {
        // Everything lists a 8k window; a ~20k-token prompt (+ response +
        // slack) fits nowhere.
        let snaps = all_keyed(vec![entry("small", Some(8_000))]);
        let err = resolve(&snaps, &query(20_000)).unwrap_err();
        assert!(err.contains("context window"), "got: {err}");
        // Same setup, tiny prompt → routed.
        let chain = resolve(&snaps, &query(100)).unwrap();
        assert_eq!(chain[0].model, "small");
    }

    #[test]
    fn unknown_window_never_excludes_a_model() {
        let mut snaps = all_keyed(vec![entry("big", Some(1_000_000)), entry("mystery", None)]);
        for s in &mut snaps {
            s.models = Ok(vec![entry("mystery", None)]);
        }
        let chain = resolve(&snaps, &query(400_000)).unwrap();
        assert_eq!(chain[0].model, "mystery");
    }

    #[test]
    fn list_order_decides_without_preferences() {
        let chain = resolve(
            &all_keyed(vec![entry("b", Some(200_000)), entry("s", Some(8_000))]),
            &query(100),
        )
        .unwrap();
        assert_eq!(chain[0].model, "b");
    }

    #[test]
    fn vision_turns_prefer_known_vision_models() {
        let models = vec![entry("text-only-small", Some(8_000)), entry("claude-3-5", None)];
        let chain = resolve(&all_keyed(models), &query(100)).map_err(|e| e.to_string());
        // vision off: smallest fits → "text-only-small"
        assert_eq!(chain.unwrap()[0].model, "text-only-small");

        let models = vec![entry("deepseek-chat", None), entry("claude-3-5", None)];
        let q = AutoQuery {
            prompt_tokens: 100,
            needs_vision: true,
            sticky: None,
            bias: Bias::Balanced,
        };
        let chain = resolve(&all_keyed(models), &q).unwrap();
        assert_eq!(chain[0].model, "claude-3-5");
    }

    #[test]
    fn vision_turns_fall_back_to_unverified_models_when_nothing_known() {
        let models = vec![entry("deepseek-chat", None), entry("qwen-coder", None)];
        let q = AutoQuery {
            prompt_tokens: 100,
            needs_vision: true,
            sticky: None,
            bias: Bias::Balanced,
        };
        let chain = resolve(&all_keyed(models), &q).unwrap();
        assert!(chain[0].reason.contains("vision unverified"), "got: {}", chain[0].reason);
    }

    #[test]
    fn sticky_pick_wins_and_moves_to_the_front() {
        let models = vec![entry("preferred-a", Some(200_000)), entry("other", Some(200_000))];
        let mut snaps = all_keyed(models);
        snaps[1].preferred_model = Some("preferred-a".to_string());
        let q = AutoQuery {
            prompt_tokens: 100,
            needs_vision: false,
            sticky: Some(("openai".to_string(), "other".to_string())),
            bias: Bias::Balanced,
        };
        let chain = resolve(&snaps, &q).unwrap();
        assert_eq!(chain[0].provider, "openai");
        assert_eq!(chain[0].model, "other");
        assert_eq!(chain[0].reason, "continuing this chat");
        // Anthropic's pick follows as fail-over.
        assert_eq!(chain[1].provider, "anthropic");
    }

    #[test]
    fn provider_default_beats_list_order() {
        let models = vec![entry("first", Some(200_000)), entry("default", Some(200_000))];
        let mut snaps = all_keyed(models);
        snaps[0].preferred_model = Some("default".to_string());
        let chain = resolve(&snaps, &query(100)).unwrap();
        assert_eq!(chain[0].model, "default");
        assert!(chain[0].reason.contains("provider default"));
    }

    #[test]
    fn stale_sticky_model_that_no_longer_qualifies_is_dropped() {
        // Sticky model's window no longer fits → the provider routes to its
        // other model instead; nothing panics, chain still starts with the
        // same provider.
        let models = vec![entry("big", Some(200_000)), entry("small", Some(8_000))];
        let q = AutoQuery {
            prompt_tokens: 100_000,
            needs_vision: false,
            sticky: Some(("anthropic".to_string(), "small".to_string())),
            bias: Bias::Balanced,
        };
        let chain = resolve(&all_keyed(models), &q).unwrap();
        assert_eq!(chain[0].provider, "anthropic");
        assert_eq!(chain[0].model, "big");
    }

    #[test]
    fn vision_sniffer_covers_the_major_families() {
        assert!(supports_vision("claude-sonnet-4-5"));
        assert!(supports_vision("gpt-4o-mini"));
        assert!(supports_vision("gpt-5"));
        assert!(supports_vision("gemini-2.0-flash"));
        assert!(supports_vision("grok-4"));
        assert!(!supports_vision("deepseek-chat"));
        assert!(!supports_vision("gpt-3.5-turbo"));
        assert!(!supports_vision("qwen3-coder"));
    }

    fn query_with_bias(prompt: u64, bias: Bias) -> AutoQuery {
        AutoQuery {
            prompt_tokens: prompt,
            needs_vision: false,
            sticky: None,
            bias,
        }
    }

    #[test]
    fn cost_class_sniffer() {
        // OpenRouter's :free convention → Free.
        assert_eq!(cost_class_for("meta-llama/llama-3.1-8b:free"), CostClass::Free);
        // Known rates: output $/Mtok drives the tier.
        assert_eq!(cost_class_for("claude-opus-4-8"), CostClass::Premium); // $25 out
        assert_eq!(cost_class_for("claude-sonnet-4-5"), CostClass::Premium); // $15 out
        assert_eq!(cost_class_for("claude-sonnet-5"), CostClass::Standard); // $10 out
        assert_eq!(cost_class_for("claude-haiku-4-5"), CostClass::Standard); // $5 out
        assert_eq!(cost_class_for("minimax-m3"), CostClass::Cheap); // $1.2 out
        assert_eq!(cost_class_for("deepseek-v4-pro"), CostClass::Cheap); // $0.87 out
        // Unknown ids are Unknown — never mispriced as free.
        assert_eq!(cost_class_for("some-future-model-x"), CostClass::Unknown);
        assert_ne!(cost_class_for("some-future-model-x"), CostClass::Free);
    }

    #[test]
    fn bias_parses_settings() {
        assert_eq!(Bias::from_setting(Some("economy")), Bias::Economy);
        assert_eq!(Bias::from_setting(Some("Quality")), Bias::Quality);
        assert_eq!(Bias::from_setting(Some("garbage")), Bias::Balanced);
        assert_eq!(Bias::from_setting(None), Bias::Balanced);
    }

    #[test]
    fn economy_promotes_free_candidates_over_provider_preference() {
        // Anthropic offers a premium pick; OpenRouter offers a free one.
        let mut snaps = all_keyed(vec![entry("claude-opus-4-8", Some(200_000))]);
        snaps[2] = snap("openrouter", true, Ok(vec![entry("qwen/free-model:free", Some(32_000))]));
        let balanced = resolve(&snaps, &query_with_bias(100, Bias::Balanced)).unwrap();
        assert_eq!(balanced[0].provider, "anthropic");
        let economy = resolve(&snaps, &query_with_bias(100, Bias::Economy)).unwrap();
        assert_eq!(economy[0].provider, "openrouter");
        assert_eq!(economy[0].model, "qwen/free-model:free");
        // Quality keeps the frontier pick in front.
        let quality = resolve(&snaps, &query_with_bias(100, Bias::Quality)).unwrap();
        assert_eq!(quality[0].provider, "anthropic");
    }

    #[test]
    fn quality_demotes_free_variants_behind_unknown_cost_models() {
        let mut snaps = all_keyed(vec![entry("deepseek-chat", Some(128_000))]);
        snaps[0] = snap("anthropic", true, Ok(vec![entry("anthropic/claude:free", Some(200_000))]));
        let quality = resolve(&snaps, &query_with_bias(100, Bias::Quality)).unwrap();
        // Anthropic's :free twin is demoted behind deepseek (unknown cost).
        assert_eq!(quality[0].provider, "openai");
        // ...but still ON the chain — demoted, not excluded.
        assert!(quality.iter().any(|c| c.model.contains(":free")));
    }

    #[test]
    fn economy_prefers_cheap_models_within_a_provider() {
        let models = vec![
            entry("claude-opus-4-8", Some(200_000)),
            entry("claude-haiku-4-5", Some(200_000)),
        ];
        let mut snaps = all_keyed(models);
        for s in &mut snaps {
            s.models = Ok(vec![
                entry("claude-opus-4-8", Some(200_000)),
                entry("claude-haiku-4-5", Some(200_000)),
            ]);
        }
        let economy = resolve(&snaps, &query_with_bias(100, Bias::Economy)).unwrap();
        assert_eq!(economy[0].model, "claude-haiku-4-5");
    }
}
