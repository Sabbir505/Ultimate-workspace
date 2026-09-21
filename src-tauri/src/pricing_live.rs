//! Live pricing layer: per-model rates auto-fetched from the LiteLLM
//! community registry (model_prices_and_context_window.json — the de-facto
//! community price list, updated within a day of new models).
//!
//! Persisted as ONE JSON blob under the `price.lite.db` settings key:
//! `{"fetched_at": <epoch secs>, "models": {"<litellm-id>": {"input": f64,
//! "output": f64, "cache_read": f64|null}}}` — rates in $/Mtok (LiteLLM's
//! per-token costs × 1e6, matching Relay's rate-table convention).
//!
//! Layering: the blob is read as a rate layer BETWEEN the compiled default
//! table and the user's explicit `price.*` pins — see
//! `db/cost_v2.rs::read_rate_overrides` (compiled default < live LiteLLM <
//! user pins; the observed-from-provider blend still fills/wins above both).
//! Absence/staleness of the blob just means the compiled table prices
//! everything, exactly as before this layer existed.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db;
use crate::harness_adapters::pricing::ModelRate;

/// Settings key holding the blob (shape in the module doc).
pub const PRICE_LITE_DB_KEY: &str = "price.lite.db";
/// Settings key holding the epoch-seconds timestamp of the last successful
/// fetch (the cost dashboard footer's "updated" line).
pub const PRICE_LITE_FETCHED_AT_KEY: &str = "price.lite.fetched_at";

const LITELLM_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/// One rate from the blob, $/Mtok. `cache_read` is None when LiteLLM
/// published no cache-read price: the rate then carries 0.0 (= unset in the
/// override-map convention) and `pricing::layer_rate` keeps the compiled
/// table's family-multiplier cache default. Only an explicit LiteLLM
/// cache-read price ever overrides that default.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LiteRate {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
}

/// The stored blob shape.
#[derive(Debug, Serialize, Deserialize)]
pub struct PriceLiteDb {
    pub fetched_at: i64,
    pub models: HashMap<String, LiteRate>,
}

/// What a successful fetch stored (also the `prices_refresh_now` reply).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchReport {
    pub stored: usize,
    pub fetched_at: i64,
}

/// Read the stored live layer as a rate map keyed by LiteLLM id. An
/// absent/unparseable blob yields an empty map — the layer simply doesn't
/// exist and the compiled table stands.
pub fn read_live_layer(conn: &Connection) -> HashMap<String, ModelRate> {
    let Some(raw) = db::get_setting(conn, PRICE_LITE_DB_KEY).ok().flatten() else {
        return HashMap::new();
    };
    let Ok(blob) = serde_json::from_str::<PriceLiteDb>(&raw) else {
        return HashMap::new();
    };
    blob.models
        .iter()
        .map(|(id, r)| {
            (
                id.clone(),
                ModelRate {
                    input_per_mtok: r.input,
                    cache_read_per_mtok: r.cache_read.unwrap_or(0.0),
                    output_per_mtok: r.output,
                },
            )
        })
        .collect()
}

/// Normalize an id for live-layer matching: lowercased, with a trailing
/// `-YYYYMMDD` date suffix stripped ("claude-sonnet-4-5-20250929" →
/// "claude-sonnet-4-5"). LiteLLM publishes dated and undated aliases of the
/// same model; Relay's canonical keys are the undated form.
fn normalize_id(id: &str) -> String {
    let lower = id.trim().to_ascii_lowercase();
    let b = lower.as_bytes();
    if b.len() > 9
        && b[b.len() - 9] == b'-'
        && b[b.len() - 8..].iter().all(|c| c.is_ascii_digit())
    {
        return lower[..lower.len() - 9].to_string();
    }
    lower
}

/// Match a Relay model key against the live layer: the exact LiteLLM id
/// first, else a normalized match (lowercase both sides; trailing
/// `-YYYYMMDD` suffixes stripped from both the key and the LiteLLM ids).
/// Ties (several aliases normalizing to the same key) pick the shortest,
/// then lexicographically smallest id — the merged map is hashed by the
/// rollup freshness marker, so the choice must be deterministic.
pub fn live_rate_for(key: &str, live: &HashMap<String, ModelRate>) -> Option<ModelRate> {
    if let Some(r) = live.get(key) {
        return Some(*r);
    }
    let norm = normalize_id(key);
    let mut hits: Vec<(&String, &ModelRate)> = live
        .iter()
        .filter(|(id, _)| normalize_id(id) == norm)
        .collect();
    hits.sort_by(|a, b| a.0.len().cmp(&b.0.len()).then_with(|| a.0.cmp(b.0)));
    hits.first().map(|(_, r)| **r)
}

/// The live layer in the override-map key space — what
/// `read_rate_overrides` merges UNDER the user's `price.*` pins. Each
/// LiteLLM id lands under its normalized form, so dated aliases fold into
/// their undated key ("claude-sonnet-4-5-20250929" is stored under
/// "claude-sonnet-4-5", the shape Relay's canonical row keys use). Keys are
/// derived in sorted order so alias folding is deterministic.
pub fn live_overrides(conn: &Connection) -> HashMap<String, ModelRate> {
    let live = read_live_layer(conn);
    let mut keys: Vec<String> = live.keys().map(|id| normalize_id(id)).collect();
    keys.sort();
    keys.dedup();
    let mut out = HashMap::new();
    for key in keys {
        if let Some(rate) = live_rate_for(&key, &live) {
            out.insert(key, rate);
        }
    }
    out
}

/// Fetch + parse the registry (network only — no DB access, so the future
/// stays Send and the caller can hold its DB lock safely afterwards).
/// Only entries carrying a finite `input_cost_per_token` are kept; every
/// rate is converted from LiteLLM's per-token dollars to $/Mtok (× 1e6).
async fn fetch_prices(client: reqwest::Client) -> Result<PriceLiteDb, String> {
    let resp = client
        .get(LITELLM_URL)
        .send()
        .await
        .map_err(|e| format!("litellm price fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("litellm price fetch HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("litellm price JSON invalid: {e}"))?;
    let models = parse_litellm_json(&json);
    if models.is_empty() {
        return Err("litellm price JSON carried no priced models".to_string());
    }
    Ok(PriceLiteDb {
        fetched_at: db::now_ts(),
        models,
    })
}

/// Pure core of [`fetch_prices`]: entries without a usable
/// `input_cost_per_token` (the real filter — plenty of the file's rows are
/// metadata or unpriced) are dropped; rates convert per-token → $/Mtok.
fn parse_litellm_json(json: &serde_json::Value) -> HashMap<String, LiteRate> {
    let mut out = HashMap::new();
    let Some(entries) = json.as_object() else {
        return out;
    };
    for (id, entry) in entries {
        let Some(input) = entry.get("input_cost_per_token").and_then(|v| v.as_f64()) else {
            continue;
        };
        if !input.is_finite() || input < 0.0 {
            continue;
        }
        let output = entry
            .get("output_cost_per_token")
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite() && *v >= 0.0)
            .unwrap_or(0.0);
        let cache_read = entry
            .get("cache_read_input_token_cost")
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite() && *v >= 0.0);
        out.insert(
            id.clone(),
            LiteRate {
                input: input * 1e6,
                output: output * 1e6,
                cache_read: cache_read.map(|c| c * 1e6),
            },
        );
    }
    out
}

/// Persist a fetched blob under the settings keys. Split from the network
/// step so a failed fetch can never touch the stored blob (the previous
/// prices stay until a fetch succeeds end-to-end).
fn store_prices(conn: &Connection, blob: &PriceLiteDb) -> Result<FetchReport, String> {
    let raw = serde_json::to_string(blob).map_err(|e| e.to_string())?;
    db::set_setting(conn, PRICE_LITE_DB_KEY, &raw).map_err(|e| e.to_string())?;
    db::set_setting(conn, PRICE_LITE_FETCHED_AT_KEY, &blob.fetched_at.to_string())
        .map_err(|e| e.to_string())?;
    Ok(FetchReport {
        stored: blob.models.len(),
        fetched_at: blob.fetched_at,
    })
}

/// Refresh the live price table: fetch the LiteLLM registry and rewrite the
/// `price.lite.*` blob. `db` is the shared connection handle (locked only
/// AFTER the network round-trip, per the DbState rule in lib.rs). Failures
/// keep the previous blob untouched and return Err — a dead network never
/// degrades stored rates.
pub async fn refresh_prices(
    client: reqwest::Client,
    db: std::sync::Arc<parking_lot::Mutex<Connection>>,
) -> Result<FetchReport, String> {
    let blob = fetch_prices(client).await?;
    let conn = db.lock();
    store_prices(&conn, &blob)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rates(pairs: &[(&str, f64, f64, Option<f64>)]) -> HashMap<String, ModelRate> {
        pairs
            .iter()
            .map(|(id, i, o, c)| {
                (
                    id.to_string(),
                    ModelRate {
                        input_per_mtok: *i,
                        cache_read_per_mtok: c.unwrap_or(0.0),
                        output_per_mtok: *o,
                    },
                )
            })
            .collect()
    }

    // ---- live_rate_for: exact / date-suffixed / miss ----

    #[test]
    fn live_rate_exact_match() {
        let live = rates(&[("glm-5.2", 1.4, 4.4, None)]);
        let r = live_rate_for("glm-5.2", &live).expect("exact id must match");
        assert_eq!(r.input_per_mtok, 1.4);
    }

    #[test]
    fn live_rate_matches_dated_alias_case_insensitively() {
        // Relay's canonical key is undated; LiteLLM publishes dated aliases.
        let live = rates(&[("Claude-Sonnet-4-5-20250929", 3.0, 15.0, Some(0.3))]);
        let r = live_rate_for("claude-sonnet-4-5", &live).expect("normalized match");
        assert_eq!(r.input_per_mtok, 3.0);
        assert_eq!(r.cache_read_per_mtok, 0.3);
        // …and the reverse direction (row key carries the date).
        let live2 = rates(&[("claude-sonnet-4-5", 3.0, 15.0, None)]);
        assert!(live_rate_for("claude-sonnet-4-5-20250929", &live2).is_some());
    }

    #[test]
    fn live_rate_miss_stays_none() {
        let live = rates(&[("gpt-4o", 2.5, 10.0, None)]);
        assert!(live_rate_for("kimi-k3", &live).is_none());
        // Only a true `-YYYYMMDD` suffix strips: a hyphen + 7 digits is part
        // of the id, not a date, so it must not fold onto the stem.
        let short = rates(&[("glm-5.2-2024010", 1.4, 4.4, None)]);
        assert!(live_rate_for("glm-5.2", &short).is_none());
    }

    #[test]
    fn live_rate_alias_ties_pick_deterministically() {
        // Both the undated and a dated alias present: the exact/shortest
        // (undated) id wins, and the choice is stable.
        let live = rates(&[
            ("claude-sonnet-4-5-20250929", 9.0, 9.0, None),
            ("claude-sonnet-4-5", 3.0, 15.0, None),
        ]);
        let r = live_rate_for("claude-sonnet-4-5", &live).unwrap();
        assert_eq!(r.input_per_mtok, 3.0, "exact id beats the dated alias");
    }

    // ---- live_overrides: dated aliases fold into the undated key ----

    #[test]
    fn live_overrides_fold_dated_aliases() {
        let conn = crate::db::mem();
        let blob = r#"{"fetched_at":100,"models":{
            "claude-sonnet-4-5-20250929":{"input":3.0,"output":15.0,"cache_read":0.3}}}"#;
        crate::db::set_setting(&conn, PRICE_LITE_DB_KEY, blob).unwrap();
        let layer = live_overrides(&conn);
        let r = layer.get("claude-sonnet-4-5").expect("folded key");
        assert_eq!(r.input_per_mtok, 3.0);
        assert_eq!(r.cache_read_per_mtok, 0.3);
        assert!(!layer.contains_key("claude-sonnet-4-5-20250929"));
    }

    #[test]
    fn live_overrides_absent_or_garbage_blob_is_empty() {
        let conn = crate::db::mem();
        assert!(live_overrides(&conn).is_empty(), "no blob → no layer");
        crate::db::set_setting(&conn, PRICE_LITE_DB_KEY, "not json").unwrap();
        assert!(live_overrides(&conn).is_empty(), "garbage blob → no layer");
    }

    // ---- parse_litellm_json ----

    #[test]
    fn parse_keeps_only_priced_entries_and_scales_to_per_mtok() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{
                "gpt-4o": {"input_cost_per_token": 0.0000025, "output_cost_per_token": 0.00001,
                            "cache_read_input_token_cost": 0.00000125},
                "unpriced-free": {"max_input_tokens": 128000},
                "metadata": {"sample_spec": "not a model"},
                "null-cost": {"input_cost_per_token": null}
            }"#,
        )
        .unwrap();
        let models = parse_litellm_json(&json);
        assert_eq!(models.len(), 1, "only entries with a numeric input cost");
        let r = models.get("gpt-4o").unwrap();
        assert!((r.input - 2.5).abs() < 1e-9, "per-token × 1e6 = $/Mtok");
        assert!((r.output - 10.0).abs() < 1e-9);
        assert_eq!(r.cache_read, Some(1.25));
    }

    #[test]
    fn parse_tolerates_non_object_payloads() {
        assert!(parse_litellm_json(&serde_json::json!([])).is_empty());
        assert!(parse_litellm_json(&serde_json::Value::Null).is_empty());
    }
}
