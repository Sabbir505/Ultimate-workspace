//! Read-time pricing for cost rollups (COST_MODEL_REDESIGN.md §7).
//!
//! One function, one source of truth: every rollup aggregate — desktop, mobile,
//! the `cost:updated` re-pricing path — goes through `price_usage`. Settings
//! overrides are layered on top of the per-key default rate at call time, so
//! changing a rate retroactively re-prices the whole history (Section 7.3).

use std::collections::HashMap;
use super::UsageInfo;
use super::default_rates;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelRate {
    pub input_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub output_per_mtok: f64,
}

/// Resolves a Settings override row (parsed from the `price.<key>.input_per_mtok`
/// / `.cache_read_per_mtok` / `.output_per_mtok` keys) into a `ModelRate`.
/// Missing fields fall back to the built-in default for the same key.
pub fn resolve_rate(key: &str, settings: &HashMap<String, ModelRate>) -> Option<ModelRate> {
    let override_rate = settings.get(key).copied();
    match default_rates(key) {
        Some((in_def, out_def)) => {
            let mut rate = ModelRate {
                input_per_mtok: in_def,
                // Anthropic default cache rate is 0.1× input. The default_rates_v2
                // table is the source of cache rates; the override is a layered
                // replacement, not a 0.1× recompute (so OpenAI's 0.5× is preserved).
                cache_read_per_mtok: in_def * 0.1,
                output_per_mtok: out_def,
            };
            if let Some(o) = override_rate {
                if o.input_per_mtok > 0.0 { rate.input_per_mtok = o.input_per_mtok; }
                if o.cache_read_per_mtok > 0.0 { rate.cache_read_per_mtok = o.cache_read_per_mtok; }
                if o.output_per_mtok > 0.0 { rate.output_per_mtok = o.output_per_mtok; }
            }
            Some(rate)
        }
        // No built-in default, but the user keyed an override for this model
        // (any OpenAI/OpenRouter/local model) — the override alone prices it.
        None => override_rate.map(|o| {
            let mut rate = ModelRate { input_per_mtok: 0.0, cache_read_per_mtok: 0.0, output_per_mtok: 0.0 };
            if o.input_per_mtok > 0.0 { rate.input_per_mtok = o.input_per_mtok; }
            if o.cache_read_per_mtok > 0.0 { rate.cache_read_per_mtok = o.cache_read_per_mtok; }
            if o.output_per_mtok > 0.0 { rate.output_per_mtok = o.output_per_mtok; }
            rate
        }),
    }
}

pub fn price_usage(
    usage: &UsageInfo,
    model_key: Option<&str>,
    settings: &HashMap<String, ModelRate>,
) -> Option<f64> {
    let key = model_key?;
    let rate = resolve_rate(key, settings)?;
    let input = usage.input_tokens.unwrap_or(0) as f64
        + usage.cache_creation_input_tokens.unwrap_or(0) as f64;
    let cached = usage.cache_read_input_tokens.unwrap_or(0) as f64;
    let output = usage.output_tokens.unwrap_or(0) as f64
        + usage.reasoning_output_tokens.unwrap_or(0) as f64;
    let cost = (input * rate.input_per_mtok
        + cached * rate.cache_read_per_mtok
        + output * rate.output_per_mtok)
        / 1_000_000.0;
    (cost > 0.0).then_some(cost)
}

pub fn cache_savings(usage: &UsageInfo, model_key: Option<&str>, settings: &HashMap<String, ModelRate>) -> f64 {
    let Some(key) = model_key else { return 0.0 };
    let Some(rate) = resolve_rate(key, settings) else { return 0.0 };
    let cached = usage.cache_read_input_tokens.unwrap_or(0) as f64;
    if cached <= 0.0 { return 0.0; }
    cached * (rate.input_per_mtok - rate.cache_read_per_mtok).max(0.0) / 1_000_000.0
}

/// Calculate electricity cost for running a local model.
///
/// Formula: cost_usd = (power_watts × hours_running × electricity_rate_per_kwh) / 1000
///
/// This uses power and time instead of tokens because local models run on
/// the user's hardware; the cost is in electricity, not API charges.
pub fn local_model_electricity_cost(
    power_watts: f64,
    duration_seconds: f64,
    electricity_rate_usd_per_kwh: f64,
) -> f64 {
    let hours = duration_seconds / 3600.0;
    (power_watts * hours * electricity_rate_usd_per_kwh) / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_adapters::UsageInfo;

    fn empty() -> HashMap<String, ModelRate> { HashMap::new() }

    #[test]
    fn price_usage_full_breakdown() {
        // claude-sonnet-4-5 = $3 in / $15 out (default), cache_read = 0.1 × in = $0.30
        let u = UsageInfo {
            input_tokens: Some(1_000_000),
            output_tokens: Some(500_000),
            cache_creation_input_tokens: Some(500_000),
            cache_read_input_tokens: Some(2_000_000),
            reasoning_output_tokens: Some(100_000),
            cost_usd: None,
        };
        // (1M + 0.5M) * 3 / 1M + 2M * 0.30 / 1M + (0.5M + 0.1M) * 15 / 1M
        // = 4.5 + 0.6 + 9.0 = 14.1
        let cost = price_usage(&u, Some("claude-sonnet-4-5"), &empty()).unwrap();
        assert!((cost - 14.1).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn price_usage_legacy_pty_row_with_null_cache() {
        // Legacy pty rows have NULL cache/reasoning; the formula must reduce
        // to the old (input * in + output * out) shape.
        let u = UsageInfo {
            input_tokens: Some(1_000_000),
            output_tokens: Some(500_000),
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            reasoning_output_tokens: None,
            cost_usd: None,
        };
        let cost = price_usage(&u, Some("claude-sonnet-4-5"), &empty()).unwrap();
        // 1M * 3 / 1M + 0.5M * 15 / 1M = 3.0 + 7.5 = 10.5
        assert!((cost - 10.5).abs() < 1e-9);
    }

    #[test]
    fn price_usage_unknown_model_is_none() {
        let u = UsageInfo { input_tokens: Some(100), output_tokens: None,
            cache_creation_input_tokens: None, cache_read_input_tokens: None,
            reasoning_output_tokens: None, cost_usd: None };
        assert!(price_usage(&u, Some("some-future-model"), &empty()).is_none());
    }

    #[test]
    fn price_usage_zero_tokens_is_none() {
        let u = UsageInfo { input_tokens: None, output_tokens: None,
            cache_creation_input_tokens: None, cache_read_input_tokens: None,
            reasoning_output_tokens: None, cost_usd: None };
        assert!(price_usage(&u, Some("claude-sonnet-4-5"), &empty()).is_none());
    }

    #[test]
    fn price_usage_settings_override_layered() {
        let u = UsageInfo { input_tokens: Some(1_000_000), output_tokens: Some(0),
            cache_creation_input_tokens: None, cache_read_input_tokens: None,
            reasoning_output_tokens: None, cost_usd: None };
        let mut s = HashMap::new();
        s.insert("claude-sonnet-4-5".into(), ModelRate {
            input_per_mtok: 5.0, cache_read_per_mtok: 0.0, output_per_mtok: 0.0,
        });
        // Override only sets input to $5; output still $15 (default)
        let cost = price_usage(&u, Some("claude-sonnet-4-5"), &s).unwrap();
        assert!((cost - 5.0).abs() < 1e-9);
    }

    #[test]
    fn cache_savings_uses_per_model_delta() {
        let u = UsageInfo { input_tokens: None, output_tokens: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: Some(1_000_000), // 1M cache reads
            reasoning_output_tokens: None, cost_usd: None };
        // claude-sonnet-4-5: input $3, cache_read $0.30, delta $2.70 / 1M tokens.
        let s = cache_savings(&u, Some("claude-sonnet-4-5"), &empty());
        assert!((s - 2.7).abs() < 1e-9);
    }

    #[test]
    fn cache_savings_zero_when_no_cache_reads() {
        let u = UsageInfo { input_tokens: Some(100), output_tokens: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            reasoning_output_tokens: None, cost_usd: None };
        let s = cache_savings(&u, Some("claude-sonnet-4-5"), &empty());
        assert_eq!(s, 0.0);
    }

    // ---- local_model_electricity_cost tests ----

    #[test]
    fn electricity_cost_basic() {
        // 100W for 1 hour at $0.15/kWh = $0.015
        let c = local_model_electricity_cost(100.0, 3600.0, 0.15);
        assert!((c - 0.015).abs() < 1e-9);
    }

    #[test]
    fn electricity_cost_30min_run() {
        // 200W for 0.5 hour at $0.12/kWh = $0.012
        let c = local_model_electricity_cost(200.0, 1800.0, 0.12);
        assert!((c - 0.012).abs() < 1e-9);
    }

    #[test]
    fn electricity_cost_zero_duration() {
        let c = local_model_electricity_cost(150.0, 0.0, 0.15);
        assert_eq!(c, 0.0);
    }

    #[test]
    fn electricity_cost_zero_rate() {
        let c = local_model_electricity_cost(150.0, 3600.0, 0.0);
        assert_eq!(c, 0.0);
    }
}
