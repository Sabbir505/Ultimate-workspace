// Provider/model health state for auto routing (AUTO_MODEL_ROUTING_RESEARCH.md
// §4.3). When a pre-stream attempt fails, the failure is classified
// (error_class.rs) and recorded here; the auto router's snapshot gathering
// consults this state to skip providers whose key is dead / credit is spent
// and models that are cooling down from a 429/5xx — LiteLLM-Router-style
// cooldowns, sized for a desktop app: in SQLite (one JSON blob in
// app_settings), no background prober, TTL-based self-healing (every entry
// expires; the next real turn re-marks a still-broken provider).
//
// Recovery paths, per flag:
// - key_invalid (401): TTL (10 min) OR the provider's /v1/models fetch
//   succeeding during snapshot gathering (on first-party endpoints a bad key
//   401s there too, so a success re-proves the key) OR a successful turn.
// - needs_credits (402 / spend-cap): TTL (10 min) or a successful turn.
// - model cooldown (429/5xx/network): `until` timestamp — retry-after when
//   the provider gave one, short defaults otherwise. Cleared by any
//   successful turn on that provider.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::error_class::{FailureKind, PreStreamFailure};

const KEY: &str = "chat.auto.health";

/// Providers excluded from auto for these long. Deliberately short: there is
/// no background prober, so a TTL is what lets a fixed key / topped-up
/// account re-enter auto without an app restart.
pub const PROVIDER_TTL_SECS: i64 = 600;
/// Default 429 cooldown when the error body carries no retry-after.
pub const RATE_LIMIT_DEFAULT_SECS: i64 = 60;
/// 5xx / unreachable-endpoint cooldown.
pub const SERVER_COOLDOWN_SECS: i64 = 90;
/// Hard cap — a parsed retry-after never cools a model down longer than this.
pub const MAX_COOLDOWN_SECS: i64 = 600;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ProviderFlags {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key_invalid_until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credits_until: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct HealthBlob {
    #[serde(default)]
    providers: HashMap<String, ProviderFlags>,
    /// "(provider)::(model)" → cooldown-until (unix secs) for 429/5xx.
    #[serde(default)]
    models: HashMap<String, i64>,
}

fn model_key(provider: &str, model: &str) -> String {
    format!("{provider}::{model}")
}

/// Why a provider is currently excluded from auto, if it is.
pub fn provider_excluded(conn: &Connection, provider: &str, now: i64) -> Option<String> {
    let blob = load(conn);
    let flags = blob.providers.get(provider)?;
    if flags.key_invalid_until.map(|u| u > now).unwrap_or(false) {
        return Some("API key invalid — update it in Settings → API Keys".to_string());
    }
    if flags.credits_until.map(|u| u > now).unwrap_or(false) {
        return Some("out of credit / spend cap reached".to_string());
    }
    None
}

/// Cooldown remaining (secs) for one model, if any.
pub fn model_cooldown_remaining(
    conn: &Connection,
    provider: &str,
    model: &str,
    now: i64,
) -> Option<i64> {
    let blob = load(conn);
    blob.models
        .get(&model_key(provider, model))
        .copied()
        .filter(|until| *until > now)
        .map(|until| until - now)
}

/// Record a classified pre-stream failure.
pub fn record_failure(
    conn: &Connection,
    provider: &str,
    model: &str,
    failure: &PreStreamFailure,
    now: i64,
) {
    let mut blob = load(conn);
    let flags = blob.providers.entry(provider.to_string()).or_default();
    match &failure.kind {
        FailureKind::Auth => flags.key_invalid_until = Some(now + PROVIDER_TTL_SECS),
        FailureKind::Payment => flags.credits_until = Some(now + PROVIDER_TTL_SECS),
        FailureKind::RateLimit { retry_after_secs } => {
            let secs = retry_after_secs
                .unwrap_or(RATE_LIMIT_DEFAULT_SECS)
                .clamp(1, MAX_COOLDOWN_SECS);
            blob.models.insert(model_key(provider, model), now + secs);
        }
        FailureKind::Server | FailureKind::Network => {
            blob.models
                .insert(model_key(provider, model), now + SERVER_COOLDOWN_SECS);
        }
        // Model-not-found is the model's own problem, not the endpoint's —
        // a longer cooldown keeps the dead id out of auto without blocking
        // the provider's other models.
        FailureKind::ModelNotFound => {
            blob.models
                .insert(model_key(provider, model), now + PROVIDER_TTL_SECS);
        }
    }
    save(conn, &blob);
}

/// A successful turn on `provider` clears its provider-level flags and every
/// model cooldown — the endpoint demonstrably works.
pub fn record_success(conn: &Connection, provider: &str, _now: i64) {
    let mut blob = load(conn);
    if let Some(flags) = blob.providers.get_mut(provider) {
        flags.key_invalid_until = None;
        flags.credits_until = None;
    }
    let prefix = format!("{provider}::");
    blob.models.retain(|k, _| !k.starts_with(&prefix));
    save(conn, &blob);
}

/// A successful /v1/models fetch proves the key works on first-party
/// endpoints (their models API 401s on a bad key). OpenRouter's models list
/// is public and proves nothing — callers pass `validates_key=false` there.
pub fn clear_key_invalid_on_fetch_ok(
    conn: &Connection,
    provider: &str,
    validates_key: bool,
    _now: i64,
) {
    if !validates_key {
        return;
    }
    let mut blob = load(conn);
    if let Some(flags) = blob.providers.get_mut(provider) {
        flags.key_invalid_until = None;
        if flags.credits_until.is_none() && flags.key_invalid_until.is_none() {
            blob.providers.remove(provider);
        }
    }
    save(conn, &blob);
}

fn load(conn: &Connection) -> HealthBlob {
    match crate::db::get_setting(conn, KEY) {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        _ => HealthBlob::default(),
    }
}

fn save(conn: &Connection, blob: &HealthBlob) {
    let now = crate::db::now_ts();
    let mut clean = blob.clone();
    // Prune expired entries on every write so the blob can't grow unbounded.
    clean.providers.retain(|_, f| {
        f.key_invalid_until.map(|u| u > now).unwrap_or(false)
            || f.credits_until.map(|u| u > now).unwrap_or(false)
    });
    clean.models.retain(|_, until| *until > now);
    if let Ok(raw) = serde_json::to_string(&clean) {
        let _ = crate::db::set_setting(conn, KEY, &raw);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::get_setting;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        conn
    }

    /// Real wall-clock base — `save()` prunes against `db::now_ts()`, so test
    /// timestamps must be realistic or every entry looks expired.
    fn now() -> i64 {
        crate::db::now_ts()
    }

    fn failure(kind: FailureKind) -> PreStreamFailure {
        PreStreamFailure { kind, status: None }
    }

    #[test]
    fn auth_failure_excludes_provider_until_ttl() {
        let conn = mem_conn();
        let now = now();
        record_failure(&conn, "anthropic", "m", &failure(FailureKind::Auth), now);
        let reason = provider_excluded(&conn, "anthropic", now + 10);
        assert!(reason.unwrap().contains("key"));
        // After the TTL it re-enters auto.
        assert!(provider_excluded(&conn, "anthropic", now + PROVIDER_TTL_SECS + 1).is_none());
    }

    #[test]
    fn payment_and_rate_limit_are_distinct() {
        let conn = mem_conn();
        let now = now();
        record_failure(
            &conn,
            "openai",
            "gpt-x",
            &failure(FailureKind::Payment),
            now,
        );
        let reason = provider_excluded(&conn, "openai", now + 10).unwrap();
        assert!(reason.contains("credit"), "got: {reason}");
        // Provider-level payment exclusion doesn't touch other providers.
        assert!(provider_excluded(&conn, "anthropic", now + 10).is_none());
    }

    #[test]
    fn rate_limit_cools_the_model_not_the_provider() {
        let conn = mem_conn();
        let now = now();
        record_failure(
            &conn,
            "openrouter",
            "a/model",
            &failure(FailureKind::RateLimit {
                retry_after_secs: Some(30),
            }),
            now,
        );
        assert_eq!(
            model_cooldown_remaining(&conn, "openrouter", "a/model", now + 5),
            Some(25)
        );
        // Another model from the same provider is untouched.
        assert_eq!(
            model_cooldown_remaining(&conn, "openrouter", "b/model", now + 5),
            None
        );
        // retry-after is honored, capped.
        record_failure(
            &conn,
            "openrouter",
            "c/model",
            &failure(FailureKind::RateLimit {
                retry_after_secs: Some(100_000),
            }),
            now,
        );
        assert!(
            model_cooldown_remaining(&conn, "openrouter", "c/model", now + 1).unwrap()
                <= MAX_COOLDOWN_SECS
        );
    }

    #[test]
    fn success_clears_everything_for_the_provider() {
        let conn = mem_conn();
        let now = now();
        record_failure(&conn, "anthropic", "m1", &failure(FailureKind::Auth), now);
        record_failure(&conn, "anthropic", "m2", &failure(FailureKind::Server), now);
        record_success(&conn, "anthropic", now + 1);
        assert!(provider_excluded(&conn, "anthropic", now + 2).is_none());
        assert_eq!(
            model_cooldown_remaining(&conn, "anthropic", "m2", now + 2),
            None
        );
        // Other providers' state survives.
        record_failure(&conn, "openai", "g", &failure(FailureKind::Auth), now + 1);
        assert!(provider_excluded(&conn, "openai", now + 2).is_some());
    }

    #[test]
    fn fetch_ok_clears_key_invalid_only_for_key_validating_endpoints() {
        let conn = mem_conn();
        let now = now();
        record_failure(&conn, "anthropic", "m", &failure(FailureKind::Auth), now);
        // OpenRouter's public models list proves nothing.
        clear_key_invalid_on_fetch_ok(&conn, "openrouter", false, now + 1);
        assert!(provider_excluded(&conn, "anthropic", now + 2).is_some());
        clear_key_invalid_on_fetch_ok(&conn, "anthropic", true, now + 1);
        assert!(provider_excluded(&conn, "anthropic", now + 2).is_none());
    }

    #[test]
    fn corrupt_blob_reads_as_healthy() {
        let conn = mem_conn();
        crate::db::set_setting(&conn, KEY, "not json").unwrap();
        assert!(provider_excluded(&conn, "anthropic", crate::db::now_ts()).is_none());
        let raw = get_setting(&conn, KEY).unwrap();
        assert!(raw.is_none() || raw.as_deref() == Some("not json"));
    }

    #[test]
    fn expired_entries_are_pruned_on_write() {
        let conn = mem_conn();
        let now = now();
        record_failure(
            &conn,
            "old",
            "m",
            &failure(FailureKind::Server),
            now - SERVER_COOLDOWN_SECS - 10,
        );
        // A write for another provider prunes the expired one.
        record_failure(&conn, "new", "m", &failure(FailureKind::Server), now);
        let raw = crate::db::get_setting(&conn, KEY).unwrap().unwrap();
        assert!(
            !raw.contains("old"),
            "expired provider survived pruning: {raw}"
        );
    }
}
