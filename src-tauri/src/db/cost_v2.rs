//! Cost rollup v2 (COST_MODEL_REDESIGN.md §8).
//!
//! Read-time pricing via `crate::harness_adapters::pricing::price_usage`.
//! Single source of truth across desktop + mobile. The rollup unions
//! `cost_events` (harness panes) with `chat_messages` (in-app chat) so the
//! dashboard treats them as one universe.

use super::DbResult;
use crate::chat::local_models::{ELECTRICITY_RATE_KEY, GPU_POWER_WATTS_KEY};
use crate::harness_adapters::pricing::{
    cache_savings, local_model_electricity_cost, price_usage, ModelRate,
};
use crate::harness_adapters::UsageInfo;
use crate::types::*;
use rusqlite::{params, Connection};
use std::collections::{BTreeMap, HashMap};

/// Read Settings overrides once: `price.<key>.{input,cache_read,output}_per_mtok`,
/// then blend in the OBSERVED rates learned from provider-reported costs
/// (see [`record_observed_pricing`]). Explicit `price.*` fields win per
/// field; observed fills the rest — so the learned rate from the user's
/// actual endpoint prices models the hardcoded table doesn't know (or knows
/// wrong, e.g. proxied billing), while a user-pinned field always wins.
/// Each row contributes one field; if the field is 0 the next layer stands.
pub fn read_rate_overrides(conn: &Connection) -> HashMap<String, ModelRate> {
    let mut out = read_explicit_rate_overrides(conn);
    // Observed (learned) layer: `cost.observed.<model>.{total_cost_usd,total_tokens}`.
    // A single blended $/Mtok across all token kinds — the observation
    // bundles cache multipliers, so no per-kind split is attempted. Keys are
    // deliberately OUTSIDE the `price.*` namespace so this query and the
    // explicit one never overlap.
    let mut stmt = match conn.prepare(
        "SELECT key, value FROM app_settings
          WHERE key LIKE 'cost.observed.%.total_cost_usd'
             OR key LIKE 'cost.observed.%.total_tokens'",
    ) {
        Ok(s) => s,
        Err(_) => return out,
    };
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
    if let Ok(rows) = rows {
        // <model, (cost, tokens)>
        let mut observed: HashMap<String, (f64, f64)> = HashMap::new();
        for row in rows.flatten() {
            let (key, value) = row;
            let Some((prefix, suffix)) = key.rsplit_once('.') else {
                continue;
            };
            let Some(model) = prefix.strip_prefix("cost.observed.") else {
                continue;
            };
            let entry = observed.entry(model.to_string()).or_insert((0.0, 0.0));
            match suffix {
                "total_cost_usd" => entry.0 = value.parse().unwrap_or(0.0),
                "total_tokens" => entry.1 = value.parse().unwrap_or(0.0),
                _ => {}
            }
        }
        for (model, (cost, tokens)) in observed {
            if cost <= 0.0 || tokens <= 0.0 {
                continue;
            }
            let blended = cost / tokens * 1_000_000.0;
            let obs_rate = ModelRate {
                input_per_mtok: blended,
                cache_read_per_mtok: blended,
                output_per_mtok: blended,
            };
            // Explicit overrides win PER FIELD: an existing entry keeps its
            // user-pinned fields, zero (unset) fields inherit the observed rate.
            let entry = out.entry(model).or_insert(obs_rate);
            if entry.input_per_mtok <= 0.0 {
                entry.input_per_mtok = obs_rate.input_per_mtok;
            }
            if entry.cache_read_per_mtok <= 0.0 {
                entry.cache_read_per_mtok = obs_rate.cache_read_per_mtok;
            }
            if entry.output_per_mtok <= 0.0 {
                entry.output_per_mtok = obs_rate.output_per_mtok;
            }
        }
    }
    out
}

/// The explicit-only `price.*` layer (user-pinned per-model rates).
fn read_explicit_rate_overrides(conn: &Connection) -> HashMap<String, ModelRate> {
    let mut out = HashMap::new();
    let mut stmt = match conn.prepare(
        "SELECT key, value FROM app_settings
          WHERE key LIKE 'price.%.input_per_mtok'
             OR key LIKE 'price.%.cache_read_per_mtok'
             OR key LIKE 'price.%.output_per_mtok'",
    ) {
        Ok(s) => s,
        Err(_) => return out,
    };
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            let (key, value) = row;
            // Key shape: "price.<model>.<suffix>". Model keys may contain dots
            // (e.g. "kimi-k2.7-code"), so split on the LAST dot, not the
            // second one.
            let Some((prefix, suffix)) = key.rsplit_once('.') else {
                continue;
            };
            let Some(model) = prefix.strip_prefix("price.") else {
                continue;
            };
            let val: f64 = value.parse().unwrap_or(0.0);
            if val <= 0.0 {
                continue;
            }
            let entry = out.entry(model.to_string()).or_insert(ModelRate {
                input_per_mtok: 0.0,
                cache_read_per_mtok: 0.0,
                output_per_mtok: 0.0,
            });
            match suffix {
                "input_per_mtok" => entry.input_per_mtok = val,
                "cache_read_per_mtok" => entry.cache_read_per_mtok = val,
                "output_per_mtok" => entry.output_per_mtok = val,
                _ => {}
            }
        }
    }
    out
}

/// Learn per-model pricing from a provider-REPORTED cost: accumulate the
/// turn's cost and token total under `cost.observed.<model_key>.*` so the
/// next rollup prices that model from the user's real billing instead of
/// the hardcoded table (or prices models the table has never heard of).
/// Called on every turn whose harness/API reported a real cost. Pure
/// accumulation — a later user override still wins per field, and the
/// rollup freshness marker changes with the totals so cached aggregates
/// re-price.
pub fn record_observed_pricing(
    conn: &Connection,
    model_key: Option<&str>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_input_tokens: i64,
    cache_creation_input_tokens: i64,
    reported_cost: f64,
) {
    use crate::db::{get_setting, set_setting};
    let Some(key) = model_key.map(str::trim).filter(|k| !k.is_empty()) else {
        return;
    };
    if reported_cost <= 0.0 {
        return;
    }
    // Reasoning tokens are excluded: OpenAI-style completion counts and
    // Claude output both already include them.
    let tokens = input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens;
    if tokens <= 0 {
        return;
    }
    let cost_key = format!("cost.observed.{key}.total_cost_usd");
    let tok_key = format!("cost.observed.{key}.total_tokens");
    let prev_cost: f64 = get_setting(conn, &cost_key)
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);
    let prev_tokens: i64 = get_setting(conn, &tok_key)
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let _ = set_setting(conn, &cost_key, &format!("{}", prev_cost + reported_cost));
    let _ = set_setting(conn, &tok_key, &format!("{}", prev_tokens + tokens));
}

/// Read local model electricity settings: USD/kWh rate + GPU power (W).
/// Returns (0, 0) when unset; callers should treat 0 as "skip electricity cost".
pub fn read_local_model_electricity_settings(conn: &Connection) -> (f64, f64) {
    use crate::db::get_setting;
    let rate = get_setting(conn, ELECTRICITY_RATE_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let watts = get_setting(conn, GPU_POWER_WATTS_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    (rate, watts)
}

fn iso_date_for_range(start_ts: i64, end_ts: i64) -> (String, String) {
    let fmt = |ts: i64| -> String {
        // Cheap Y-M-D via chrono-free computation: civil_from_days from Howard Hinnant.
        let secs_per_day = 86_400i64;
        let days = (ts / secs_per_day) + 719_468; // shift epoch to civil day 0 = 0000-03-01
        let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
        let doe = (days - era * 146_097) as u64;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = (yoe as i64) + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
        let year = if m <= 2 { y + 1 } else { y };
        format!("{:04}-{:02}-{:02}", year, m, d)
    };
    (fmt(start_ts), fmt(end_ts))
}

pub fn get_cost_rollups_v2(conn: &Connection, range_days: u32) -> DbResult<CostRollups> {
    // Any positive range is valid here — the 7|30|90 whitelist lives at the
    // IPC boundary (commands/data.rs) so the mobile relay can ask for 14 days.
    let days = range_days.max(1);

    // mi26: the mobile relay + cost dashboard poll this whole aggregation on
    // a timer. Cache per `days`, validated by a cheap freshness marker —
    // MAX(timestamp) of both source tables + the rate overrides + a 10-min
    // time bucket (the bucket bounds staleness from rows AGING OUT of the
    // sliding window when no new rows arrive; new rows invalidate instantly
    // via the MAX markers). A poll with no new cost data now costs two
    // indexed MAX() lookups instead of two range scans + pricing.
    let marker = rollup_freshness_marker(conn)?;
    let cache = ROLLUP_CACHE.get_or_init(|| parking_lot::Mutex::new(HashMap::new()));
    {
        let guard = cache.lock();
        if let Some((m, cached)) = guard.get(&days) {
            if *m == marker {
                return Ok(cached.clone());
            }
        }
    }
    let fresh = compute_cost_rollups_v2(conn, days)?;
    {
        let mut guard = cache.lock();
        if guard.len() >= 8 {
            guard.clear();
        }
        guard.insert(days, (marker, fresh.clone()));
    }
    Ok(fresh)
}

/// mi26: process-wide rollup cache — see get_cost_rollups_v2.
static ROLLUP_CACHE: std::sync::OnceLock<parking_lot::Mutex<HashMap<u32, (String, CostRollups)>>> =
    std::sync::OnceLock::new();

/// Test isolation: the cache is process-global and its marker is
/// deterministic, so tests sharing one process would serve each other's
/// cached rollups. Call at the start of any test that calls
/// `get_cost_rollups_v2`.
#[cfg(test)]
pub(crate) fn reset_rollup_cache_for_tests() {
    if let Some(cache) = ROLLUP_CACHE.get() {
        cache.lock().clear();
    }
}

/// Reset + compute serialized against the process-global cache — parallel
/// test threads resetting/inserting around each other could otherwise serve
/// another fixture's cached rollup (two empty DBs share the same marker).
#[cfg(test)]
fn rollups_for_tests(conn: &Connection) -> CostRollups {
    static LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
    let _guard = LOCK.lock();
    reset_rollup_cache_for_tests();
    get_cost_rollups_v2(conn, 7).unwrap()
}

/// Cheap O(indexed MAX) staleness marker for the rollup cache. Covers both
/// source tables (cost_events, assistant chat_messages), the rate overrides
/// (pricing inputs), and a 10-minute time bucket so rows aging out of the
/// sliding window refresh at most 10 min late.
fn rollup_freshness_marker(conn: &Connection) -> DbResult<String> {
    let max_ev: Option<i64> =
        conn.query_row("SELECT MAX(timestamp) FROM cost_events", [], |r| r.get(0))?;
    let max_msg: Option<i64> = conn.query_row(
        "SELECT MAX(created_at) FROM chat_messages WHERE role = 'assistant'",
        [],
        |r| r.get(0),
    )?;
    let overrides = read_rate_overrides(conn);
    // Hash the overrides map (tiny) — order-independent via BTreeMap fold.
    // DefaultHasher: a FIXED-key hasher. RandomState::new() (random keys per
    // instance) made `finish()` differ on every call, so the marker never
    // matched and the mi26 cache never hit — every poll recomputed the full
    // aggregation. Nothing security-sensitive rides on this hash; it only
    // needs determinism within one process.
    let overrides_hash = {
        use std::hash::Hasher;
        let sorted: BTreeMap<_, _> = overrides.iter().collect();
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for (k, v) in sorted {
            h.write(k.as_bytes());
            h.write_u64(v.input_per_mtok.to_bits());
            h.write_u64(v.cache_read_per_mtok.to_bits());
            h.write_u64(v.output_per_mtok.to_bits());
        }
        h.finish()
    };
    let bucket = crate::db::now_ts() / 600;
    Ok(format!(
        "{}:{}:{:x}:{}",
        max_ev.unwrap_or(0),
        max_msg.unwrap_or(0),
        overrides_hash,
        bucket
    ))
}

fn compute_cost_rollups_v2(conn: &Connection, days: u32) -> DbResult<CostRollups> {
    let now = crate::db::now_ts();
    let since = now - (days as i64) * 86_400;
    let overrides = read_rate_overrides(conn);
    let (elec_rate, gpu_watts) = read_local_model_electricity_settings(conn);
    let (range_start, range_end) = iso_date_for_range(since, now);

    let mut totals = CostTotals::default();
    let mut by_provider: BTreeMap<String, (f64, i64)> = BTreeMap::new();
    let mut by_model: BTreeMap<String, (f64, i64, Option<String>)> = BTreeMap::new();
    let mut by_kind = CostByKind::default();
    let mut daily_map: BTreeMap<String, DailyCost> = BTreeMap::new();
    let mut responses: i64 = 0;
    // Row-count trackers for the cost-quality panel (spec §13.3: percentages
    // are shares of rows, and must sum to 100).
    let mut total_rows: i64 = 0;
    let mut provider_reported_rows: i64 = 0;
    let mut unpriced_rows: i64 = 0;

    // ----- cost_events (harness panes) -----
    // session_id → project_id map for the per-project rollup (read-time priced,
    // NOT the write-only pricing_estimated_usd column).
    let session_project: HashMap<String, String> = {
        let mut stmt = conn.prepare("SELECT id, project_id FROM sessions")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<DbResult<HashMap<_, _>>>()?
    };
    let mut by_project: BTreeMap<String, (f64, i64, i64)> = BTreeMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT timestamp, input_tokens, output_tokens, provider, model_key,
                    cache_creation_input_tokens, cache_read_input_tokens,
                    reasoning_output_tokens, reported_cost_usd, session_id
               FROM cost_events
              WHERE timestamp >= ?1",
        )?;
        let rows = stmt.query_map(params![since], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, Option<i64>>(6)?,
                r.get::<_, Option<i64>>(7)?,
                r.get::<_, Option<f64>>(8)?,
                r.get::<_, String>(9)?,
            ))
        })?;
        for row in rows {
            let (ts, i, o, provider, model_key, cc, cr, reasoning, reported, sid) = row?;
            let usage = UsageInfo {
                input_tokens: i,
                output_tokens: o,
                cache_creation_input_tokens: cc,
                cache_read_input_tokens: cr,
                reasoning_output_tokens: reasoning,
                cost_usd: None,
            };
            // Rows with NULL model_key price at the harness's default model
            // (spec §7.2 — "priced as harness default"). The provider column
            // carries the harness id ('claude_code' | 'kimi_code' | 'opencode').
            let key = model_key.as_deref().or_else(|| {
                provider
                    .as_deref()
                    .map(crate::harness_adapters::harness_default_model_key)
            });
            // Prefer the cost the harness actually reported (e.g. Claude Code's
            // "Total cost: $X.XX" line, scraped from pty output). Fall back to
            // rate-based estimation only when the harness didn't report one —
            // so the Pricing section's rate table is just a safety net, not
            // the primary source. (Spec §7.5: reported vs estimated stay distinct.)
            let cost = reported.or_else(|| price_usage(&usage, key, &overrides));
            let tokens_i = i.unwrap_or(0)
                + cc.unwrap_or(0)
                + cr.unwrap_or(0)
                + o.unwrap_or(0)
                + reasoning.unwrap_or(0);
            let day = date_str(ts);
            total_rows += 1;
            if let Some(c) = cost {
                totals.raw_token_cost_usd += c;
                totals.estimated_usd += c;
                if let Some(p) = provider.as_deref() {
                    let entry = by_provider.entry(p.to_string()).or_insert((0.0, 0));
                    entry.0 += c;
                    entry.1 += tokens_i;
                }
                if let Some(k) = key {
                    let entry = by_model
                        .entry(k.to_string())
                        .or_insert((0.0, 0, provider.clone()));
                    entry.0 += c;
                    entry.1 += tokens_i;
                }
                let d = daily_map.entry(day.clone()).or_insert_with(|| DailyCost {
                    day: day.clone(),
                    ..Default::default()
                });
                d.cost_usd += c;
                let prov_label = provider.clone().unwrap_or_else(|| "unknown".to_string());
                *d.tokens_by_provider.entry(prov_label.clone()).or_insert(0) += tokens_i;
                *d.cost_by_provider.entry(prov_label).or_insert(0.0) += c;
                totals.cache_savings_usd_via_helper += cache_savings(&usage, key, &overrides);
            } else {
                totals.unpriced_usd += reported.unwrap_or(0.0);
                unpriced_rows += 1;
            }
            if let Some(r) = reported {
                totals.provider_reported_usd += r;
                provider_reported_rows += 1;
            }
            if let Some(pid) = session_project.get(&sid) {
                let entry = by_project.entry(pid.clone()).or_insert((0.0, 0, 0));
                entry.0 += cost.unwrap_or(0.0);
                entry.1 += i.unwrap_or(0);
                entry.2 += o.unwrap_or(0);
            }
            by_kind.uncached_input_tokens += i.unwrap_or(0);
            by_kind.cached_input_tokens += cc.unwrap_or(0) + cr.unwrap_or(0);
            by_kind.output_tokens += o.unwrap_or(0) + reasoning.unwrap_or(0);
            by_kind.reasoning_tokens += reasoning.unwrap_or(0);
            responses += 1;
        }
    }

    // ----- chat_messages (in-app chat) -----
    {
        // provider: coalesce the row's own provider with the chat session's —
        // rows written before the provider column existed carry NULL and would
        // otherwise show as "chat:unknown". The RAW session provider rides
        // along too: only harness-backed rows ("harness:*" sessions) carry a
        // provider-REPORTED cost (claude's total_cost_usd, opencode's
        // info.cost) — built-in chat rows hold the coarse per-family
        // estimate, which the rate table prices better.
        let mut stmt = conn.prepare(
            "SELECT cm.created_at, cm.input_tokens, cm.output_tokens,
                    COALESCE(cm.provider, cs.provider) AS provider, cm.model_key,
                    cm.cache_creation_input_tokens, cm.cache_read_input_tokens,
                    cm.reasoning_output_tokens, cs.model,
                    cm.started_at, cm.completed_at, cs.project_id,
                    cm.cost_usd, cs.provider
               FROM chat_messages cm
               JOIN chat_sessions cs ON cs.id = cm.chat_session_id
              WHERE cm.created_at >= ?1 AND cm.role = 'assistant'",
        )?;
        let rows = stmt.query_map(params![since], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, Option<i64>>(6)?,
                r.get::<_, Option<i64>>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, Option<i64>>(9)?,
                r.get::<_, Option<i64>>(10)?,
                r.get::<_, Option<String>>(11)?,
                r.get::<_, Option<f64>>(12)?,
                r.get::<_, Option<String>>(13)?,
            ))
        })?;
        for row in rows {
            let (
                ts,
                i,
                o,
                provider,
                model_key,
                cc,
                cr,
                reasoning,
                session_model,
                started_at,
                completed_at,
                chat_project,
                reported_cost,
                session_provider,
            ) = row?;
            let usage = UsageInfo {
                input_tokens: i,
                output_tokens: o,
                cache_creation_input_tokens: cc,
                cache_read_input_tokens: cr,
                reasoning_output_tokens: reasoning,
                cost_usd: None,
            };
            // Chat rows with NULL model_key fall back to the chat session's
            // model (canonicalized), mirroring the harness default fallback.
            let key = model_key.as_deref().or_else(|| {
                session_model
                    .as_deref()
                    .and_then(crate::harness_adapters::canonical_model_key)
            });
            // Pricing gets one more chance than grouping does: when the
            // canonical map doesn't know the session's model either (a newer
            // GLM/Kimi/DeepSeek release, a provider-prefixed commandcode id),
            // the RAW id still prices via the rate table's family fallback —
            // the harnesses that never report a cost (commandcode) otherwise
            // show real token counts at $0.00 forever. Grouping keeps the
            // canonical key so the per-model table doesn't fragment.
            let pricing_key = key.or(session_model.as_deref());
            // Local models: derive cost from electricity (power × duration × rate).
            // No rate table — they run on the user's hardware. Cloud models keep
            // the per-token rate calculation. Harness-backed sessions prefer the
            // cost the CLI itself reported on the row (claude's total_cost_usd,
            // opencode's info.cost) — same precedence as the cost_events branch
            // above — and only rate-estimate when it stored NULL.
            let is_harness_session = session_provider
                .as_deref()
                .map(|p| p.starts_with("harness:"))
                .unwrap_or(false);
            let cost = match provider.as_deref() {
                Some("local_gguf") if elec_rate > 0.0 && gpu_watts > 0.0 => {
                    let duration_s = match (started_at, completed_at) {
                        (Some(s), Some(c)) if c > s => (c - s) as f64,
                        _ => 0.0,
                    };
                    let c = local_model_electricity_cost(gpu_watts, duration_s, elec_rate);
                    (c > 0.0).then_some(c)
                }
                // Local rows without electricity settings stay UNPRICED: a
                // GGUF basename often carries a family substring
                // ("qwen2.5-…gguf") and the rate table's family fallback
                // would otherwise price the user's own hardware at API rates.
                Some("local_gguf") => None,
                _ if is_harness_session => {
                    reported_cost.or_else(|| price_usage(&usage, pricing_key, &overrides))
                }
                _ => price_usage(&usage, pricing_key, &overrides),
            };
            if is_harness_session {
                if let Some(r) = reported_cost {
                    totals.provider_reported_usd += r;
                    provider_reported_rows += 1;
                }
            }
            let tokens_i = i.unwrap_or(0)
                + cc.unwrap_or(0)
                + cr.unwrap_or(0)
                + o.unwrap_or(0)
                + reasoning.unwrap_or(0);
            let grouped = format!(
                "chat:{}",
                provider.clone().unwrap_or_else(|| "unknown".to_string())
            );
            total_rows += 1;
            let c = cost.unwrap_or(0.0);
            // Chat rows count toward the hero total too (spec §8: harness + chat
            // are one universe; per-provider shares must sum to rawTokenCostUsd).
            totals.raw_token_cost_usd += c;
            totals.estimated_usd += c;
            if cost.is_none() {
                totals.unpriced_usd += c;
                unpriced_rows += 1;
            }
            let entry = by_provider.entry(grouped.clone()).or_insert((0.0, 0));
            entry.0 += c;
            entry.1 += tokens_i;
            // Local/unpriced models (GGUF names have no canonical key) still
            // appear in the per-model breakdown under their raw model name,
            // with $0 cost — they run on your hardware, not an API.
            // The session model may be a full file path (GGUF files without a
            // metadata name); display just the basename so the table reads
            // "qwen2.5-7b-q4_k_m.gguf" not "C:\models\qwen2.5-7b-q4_k_m.gguf".
            let model_label = key
                .map(String::from)
                .or_else(|| session_model.as_deref().map(basename))
                .unwrap_or_else(|| "unknown".to_string());
            let entry = by_model
                .entry(model_label)
                .or_insert((0.0, 0, Some(grouped.clone())));
            entry.0 += c;
            entry.1 += tokens_i;
            let day = date_str(ts);
            let d = daily_map.entry(day.clone()).or_insert_with(|| DailyCost {
                day: day.clone(),
                ..Default::default()
            });
            d.cost_usd += c;
            *d.tokens_by_provider.entry(grouped.clone()).or_insert(0) += tokens_i;
            *d.cost_by_provider.entry(grouped).or_insert(0.0) += c;
            // In-app chat spend counts toward the session's project too — the
            // budget check prices "the same universe as the cost dashboard"
            // (cost_events + assistant chat_messages), and a chat-only project
            // used to read $0.00 so its alert never fired.
            if let Some(pid) = chat_project {
                let entry = by_project.entry(pid).or_insert((0.0, 0, 0));
                entry.0 += c;
                entry.1 += i.unwrap_or(0);
                entry.2 += o.unwrap_or(0);
            }
            totals.cache_savings_usd_via_helper += cache_savings(&usage, pricing_key, &overrides);
            by_kind.uncached_input_tokens += i.unwrap_or(0);
            by_kind.cached_input_tokens += cc.unwrap_or(0) + cr.unwrap_or(0);
            by_kind.output_tokens += o.unwrap_or(0) + reasoning.unwrap_or(0);
            by_kind.reasoning_tokens += reasoning.unwrap_or(0);
            responses += 1;
        }
    }

    by_kind.processed_tokens = by_kind.uncached_input_tokens + by_kind.cached_input_tokens;
    by_kind.responses = responses;
    // Sessions: distinct harness sessions (cost_events) + distinct chat
    // sessions with at least one assistant row in the window.
    by_kind.sessions = count_distinct_sessions(conn, since).unwrap_or(0)
        + count_distinct_chat_sessions(conn, since).unwrap_or(0);

    let mut per_provider: Vec<ProviderCostRollup> = by_provider
        .iter()
        .map(|(p, (c, t))| ProviderCostRollup {
            provider: p.clone(),
            cost_usd: *c,
            tokens: *t,
            share_pct: if totals.raw_token_cost_usd > 0.0 {
                *c / totals.raw_token_cost_usd * 100.0
            } else {
                0.0
            },
        })
        .collect();
    per_provider.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut per_model: Vec<ModelCostRollup> = by_model
        .iter()
        .map(|(k, (c, t, p))| ModelCostRollup {
            model_key: k.clone(),
            display_name: k.clone(),
            cost_usd: *c,
            share_pct: if totals.raw_token_cost_usd > 0.0 {
                *c / totals.raw_token_cost_usd * 100.0
            } else {
                0.0
            },
            tokens: *t,
            provider: p.clone(),
        })
        .collect();
    per_model.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // perProject — read-time priced (accumulated in the cost_events loop above;
    // never the write-only pricing_estimated_usd column, spec §7).
    let per_project: Vec<ProjectCostRollup> = by_project
        .iter()
        .map(|(pid, (c, ti, to))| ProjectCostRollup {
            project_id: pid.clone(),
            total_cost_usd: *c,
            total_input_tokens: *ti,
            total_output_tokens: *to,
        })
        .collect();

    let mut daily: Vec<DailyCost> = daily_map.into_values().collect();
    daily.sort_by(|a, b| a.day.cmp(&b.day));

    // Cost quality: ROW COUNTS (spec §13.3 — the three %s must sum to 100).
    let total_rows_f = (total_rows as f64).max(1.0);
    let cost_quality = CostQuality {
        provider_reported_pct: provider_reported_rows as f64 / total_rows_f * 100.0,
        model_priced_pct: ((total_rows - unpriced_rows).max(0) as f64) / total_rows_f * 100.0,
        unpriced_pct: unpriced_rows as f64 / total_rows_f * 100.0,
        cache_savings_usd: totals.cache_savings_usd_via_helper,
    };

    // cache_savings_usd on CostTotals is a temp accumulator; zero it out on the
    // returned struct (it lives on CostQuality).
    totals.cache_savings_usd_via_helper = 0.0;

    Ok(CostRollups {
        totals,
        per_provider,
        daily,
        by_kind,
        per_model,
        cost_quality,
        per_project,
        range_start,
        range_end,
        range_days: days,
    })
}

/// Last path segment of a model string, minus the extension. Local GGUF
/// sessions store the model as a full file path when the GGUF header has no
/// `general.name` metadata; the dashboard shows only the filename.
fn basename(s: &str) -> String {
    let trimmed = s.trim_end_matches(['/', '\\']);
    let leaf = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    match leaf.rsplit_once('.') {
        Some((stem, ext))
            if !ext.is_empty()
                && ext.len() <= 8
                && ext.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            stem.to_string()
        }
        _ => leaf.to_string(),
    }
}

fn date_str(ts: i64) -> String {
    let secs_per_day = 86_400i64;
    let days = (ts / secs_per_day) + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = (days - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", year, m, d)
}

fn count_distinct_sessions(conn: &Connection, since: i64) -> DbResult<i64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT session_id) FROM cost_events WHERE timestamp >= ?1",
        params![since],
        |r| r.get(0),
    )?;
    Ok(n)
}

fn count_distinct_chat_sessions(conn: &Connection, since: i64) -> DbResult<i64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT chat_session_id) FROM chat_messages
          WHERE created_at >= ?1 AND role = 'assistant'",
        params![since],
        |r| r.get(0),
    )?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::insert_cost_event;
    use crate::harness_adapters::UsageInfo;

    #[test]
    fn observed_pricing_accumulates_and_prices_unknown_models() {
        // A model the hardcoded rate table has NEVER heard of becomes
        // priceable once a provider-reported cost lands: the observed
        // blended rate prices it from real billing.
        let conn = super::super::mem();
        record_observed_pricing(&conn, Some("my-proxy-glm-x"), 1_000_000, 500_000, 0, 0, 3.0);
        // A second turn folds INTO the same accumulator (running totals).
        record_observed_pricing(&conn, Some("my-proxy-glm-x"), 1_000_000, 0, 0, 0, 1.0);

        let rates = read_rate_overrides(&conn);
        let rate = rates.get("my-proxy-glm-x").expect("observed rate must surface");
        // 4.0 USD over 2.5M tokens = 1.6 $/Mtok blended.
        assert!((rate.input_per_mtok - 1.6).abs() < 1e-9, "got {}", rate.input_per_mtok);

        let u = UsageInfo {
            input_tokens: Some(1_000_000),
            output_tokens: Some(250_000),
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            reasoning_output_tokens: None,
            cost_usd: None,
        };
        let cost = price_usage(&u, Some("my-proxy-glm-x"), &rates);
        assert!(cost.is_some(), "unknown model must price via observed rate");
        assert!((cost.unwrap() - 2.0).abs() < 1e-9, "got {}", cost.unwrap());
    }

    #[test]
    fn observed_pricing_ignored_without_tokens_or_cost() {
        let conn = super::super::mem();
        record_observed_pricing(&conn, Some("m1"), 0, 0, 0, 0, 5.0);
        record_observed_pricing(&conn, Some("m2"), 1_000, 0, 0, 0, 0.0);
        record_observed_pricing(&conn, None, 1_000, 0, 0, 0, 5.0);
        assert!(
            read_rate_overrides(&conn).is_empty(),
            "no cost or no tokens must not create a rate"
        );
    }

    #[test]
    fn explicit_override_wins_over_observed_per_field() {
        let conn = super::super::mem();
        // Observed: 2.0 USD over 1M tokens → blended 2.0.
        record_observed_pricing(&conn, Some("my-model"), 750_000, 250_000, 0, 0, 2.0);
        // User pins ONLY the input rate.
        crate::db::set_setting(&conn, "price.my-model.input_per_mtok", "9.0").unwrap();
        let rates = read_rate_overrides(&conn);
        let rate = rates.get("my-model").unwrap();
        assert!((rate.input_per_mtok - 9.0).abs() < 1e-9, "pinned field wins");
        assert!(
            (rate.output_per_mtok - 2.0).abs() < 1e-9,
            "unpinned field inherits observed: got {}",
            rate.output_per_mtok
        );
    }

    #[test]
    fn observed_rate_changes_freshness_marker() {
        // A new observation must invalidate the rollup cache so aggregates
        // re-price (the marker hashes the merged override map).
        let conn = super::super::mem();
        let before = rollup_freshness_marker(&conn).unwrap();
        record_observed_pricing(&conn, Some("fresh-model"), 1_000, 0, 0, 0, 0.5);
        let after = rollup_freshness_marker(&conn).unwrap();
        assert_ne!(before, after, "new observation must re-price rollups");
    }

    #[test]
    fn rollup_totals_match_sum() {
        let conn = super::super::mem();
        let p = super::super::add_project(&conn, "/tmp/a", "a", false).unwrap();
        let s = super::super::create_session(&conn, &p.id, "claude_code").unwrap();
        let u = |i: i64, o: i64, cc: i64, cr: i64, r: i64| UsageInfo {
            input_tokens: Some(i),
            output_tokens: Some(o),
            cache_creation_input_tokens: Some(cc),
            cache_read_input_tokens: Some(cr),
            reasoning_output_tokens: Some(r),
            cost_usd: None,
        };
        // 1M input + 0.5M cache_creation @ $3 = 4.5;
        // 2M cache_read @ $0.30 = 0.6; 0.5M output @ $15 = 7.5.
        // = 12.6 per event (the test passes r=0 for reasoning).
        for _ in 0..3 {
            insert_cost_event(
                &conn,
                &s.id,
                &u(1_000_000, 500_000, 500_000, 2_000_000, 0),
                "claude_code",
                "on_disk",
                Some(12.6),
            )
            .unwrap();
        }
        let r = rollups_for_tests(&conn);
        assert!(
            (r.totals.raw_token_cost_usd - 37.8).abs() < 1e-6,
            "got {}",
            r.totals.raw_token_cost_usd
        );
        assert_eq!(r.per_provider.len(), 1);
        assert_eq!(r.per_provider[0].provider, "claude_code");
        assert!((r.per_provider[0].cost_usd - 37.8).abs() < 1e-6);
    }

    #[test]
    fn freshness_marker_is_deterministic() {
        // mi26 regression: the marker used RandomState::new(), whose random
        // per-instance keys made `finish()` differ on EVERY call — the cache
        // comparison never matched and the whole rollup recomputed per poll.
        // The marker must be stable across calls with unchanged inputs.
        let conn = super::super::mem();
        let m1 = rollup_freshness_marker(&conn).unwrap();
        let m2 = rollup_freshness_marker(&conn).unwrap();
        assert_eq!(m1, m2, "unchanged inputs must produce an identical marker");

        // Different override values must change the marker (the cache must
        // invalidate when pricing inputs change).
        let before = rollup_freshness_marker(&conn).unwrap();
        crate::db::set_setting(&conn, "price.m1.input_per_mtok", "1.0").unwrap();
        crate::db::set_setting(&conn, "price.m1.output_per_mtok", "2.0").unwrap();
        let after = rollup_freshness_marker(&conn).unwrap();
        assert_ne!(before, after, "rate overrides participate in the marker");
    }

    #[test]
    fn rollup_unions_chat_messages() {
        let conn = super::super::mem();
        let cs = super::super::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None)
            .unwrap();
        super::super::add_chat_message(
            &conn,
            super::super::NewChatMessage {
                chat_session_id: &cs.id,
                role: "assistant",
                content: "hi",
                input_tokens: Some(1_000_000),
                output_tokens: Some(500_000),
                cost_usd: Some(0.0),
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                reasoning_output_tokens: None,
                provider: Some("anthropic"),
                model_key: None,
                pricing_estimated_usd: None,
                started_at: None,
                completed_at: None,
                llm_time_ms: None,
                tool_time_ms: None,
                ttft_ms: None,
                tokens_per_second: None,
            },
        )
        .unwrap();
        let r = rollups_for_tests(&conn);
        // claude-sonnet-4-5: $3 input, $15 output → 1M*3/1M + 0.5M*15/1M = 10.5
        let chat_provider = r
            .per_provider
            .iter()
            .find(|p| p.provider == "chat:anthropic")
            .unwrap();
        assert!(
            (chat_provider.cost_usd - 10.5).abs() < 1e-6,
            "got {}",
            chat_provider.cost_usd
        );
        // The hero total must include chat rows (spec §8: per-provider shares
        // sum to rawTokenCostUsd). Regression for the missing-totals bug.
        assert!(
            (r.totals.raw_token_cost_usd - 10.5).abs() < 1e-6,
            "got {}",
            r.totals.raw_token_cost_usd
        );
        assert!((r.daily.iter().map(|d| d.cost_usd).sum::<f64>() - 10.5).abs() < 1e-6);
        // Cost-quality %s are row counts and sum to 100 (spec §13.3).
        assert!(
            (r.cost_quality.provider_reported_pct
                + r.cost_quality.model_priced_pct
                + r.cost_quality.unpriced_pct
                - 100.0)
                .abs()
                < 1e-6
        );
    }

    #[test]
    fn harness_chat_rows_prefer_reported_cost() {
        // A harness-backed session's rows carry the cost the CLI itself
        // reported (claude's total_cost_usd, opencode's info.cost). The
        // rollup must prefer it over the rate-table estimate — same
        // precedence as the cost_events branch — and rate-price only the
        // rows where no cost was reported. Built-in chat rows keep using
        // the rate table (their stored figure is the coarse family
        // estimate).
        let conn = super::super::mem();
        let cs = super::super::create_chat_session(
            &conn,
            "harness:claude_code",
            "claude-opus-4-8",
            None,
        )
        .unwrap();
        // Reported $0.77 on a turn whose rate-table estimate would be $5
        // (1M input @ opus $5/Mtok, no cache).
        super::super::add_chat_message(
            &conn,
            super::super::NewChatMessage {
                chat_session_id: &cs.id,
                role: "assistant",
                content: "reported",
                input_tokens: Some(1_000_000),
                output_tokens: Some(0),
                cost_usd: Some(0.77),
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                reasoning_output_tokens: None,
                provider: Some("claude_code"),
                model_key: Some("claude-opus-4-8"),
                pricing_estimated_usd: None,
                started_at: None,
                completed_at: None,
                llm_time_ms: None,
                tool_time_ms: None,
                ttft_ms: None,
                tokens_per_second: None,
            },
        )
        .unwrap();
        // NULL-cost row falls back to the rate table: 1M @ $5 = $5.00.
        super::super::add_chat_message(
            &conn,
            super::super::NewChatMessage {
                chat_session_id: &cs.id,
                role: "assistant",
                content: "estimated",
                input_tokens: Some(1_000_000),
                output_tokens: Some(0),
                cost_usd: None,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                reasoning_output_tokens: None,
                provider: Some("claude_code"),
                model_key: Some("claude-opus-4-8"),
                pricing_estimated_usd: None,
                started_at: None,
                completed_at: None,
                llm_time_ms: None,
                tool_time_ms: None,
                ttft_ms: None,
                tokens_per_second: None,
            },
        )
        .unwrap();
        let r = rollups_for_tests(&conn);
        assert!(
            (r.totals.raw_token_cost_usd - 5.77).abs() < 1e-6,
            "reported cost must win on its row: got {}",
            r.totals.raw_token_cost_usd
        );
        // The reported row counts into the provider-reported quality share.
        assert!(
            r.cost_quality.provider_reported_pct > 0.0,
            "harness-reported cost must surface in cost quality: {}",
            r.cost_quality.provider_reported_pct
        );
    }

    #[test]
    fn commandcode_unknown_model_prices_at_family_rate() {
        // The commandcode case: the CLI reports usage but NEVER a cost or a
        // model id, so the row carries cost_usd NULL / model_key NULL and the
        // rollup's only lead is the session's model. For an id the rate table
        // has never heard of ("zai/glm-5.3" — canonical_model_key knows only
        // glm-5.1/5.2) the row used to show real tokens at $0.00 forever. The
        // family-rate fallback prices it at glm-5.2's researched rate.
        let conn = super::super::mem();
        let cs = super::super::create_chat_session(
            &conn,
            "harness:commandcode",
            "zai/glm-5.3",
            None,
        )
        .unwrap();
        super::super::add_chat_message(
            &conn,
            super::super::NewChatMessage {
                chat_session_id: &cs.id,
                role: "assistant",
                content: "answered",
                input_tokens: Some(1_000_000),
                output_tokens: Some(500_000),
                cost_usd: None,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                reasoning_output_tokens: None,
                provider: Some("commandcode"),
                model_key: None,
                pricing_estimated_usd: None,
                started_at: None,
                completed_at: None,
                llm_time_ms: None,
                tool_time_ms: None,
                ttft_ms: None,
                tokens_per_second: None,
            },
        )
        .unwrap();
        let r = rollups_for_tests(&conn);
        // glm family fallback (glm-5.2: $1.4 in / $4.4 out): 1M in + 0.5M out
        // = 1.4 + 2.2 = $3.60 instead of $0.00.
        assert!(
            (r.totals.raw_token_cost_usd - 3.6).abs() < 1e-6,
            "unknown glm id must price at the family rate: got {}",
            r.totals.raw_token_cost_usd
        );
    }

    #[test]
    fn builtin_chat_rows_still_rate_price_over_stored_estimate() {
        // Built-in chat rows store the coarse per-family estimate — the rate
        // table must keep winning there (anthropic $3/$15): 1M in + 0.5M out
        // = $10.50 regardless of the stored figure.
        let conn = super::super::mem();
        let cs = super::super::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None)
            .unwrap();
        super::super::add_chat_message(
            &conn,
            super::super::NewChatMessage {
                chat_session_id: &cs.id,
                role: "assistant",
                content: "hi",
                input_tokens: Some(1_000_000),
                output_tokens: Some(500_000),
                cost_usd: Some(99.0),
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                reasoning_output_tokens: None,
                provider: Some("anthropic"),
                model_key: None,
                pricing_estimated_usd: None,
                started_at: None,
                completed_at: None,
                llm_time_ms: None,
                tool_time_ms: None,
                ttft_ms: None,
                tokens_per_second: None,
            },
        )
        .unwrap();
        let r = rollups_for_tests(&conn);
        assert!(
            (r.totals.raw_token_cost_usd - 10.5).abs() < 1e-6,
            "rate table must win for built-in providers: got {}",
            r.totals.raw_token_cost_usd
        );
    }

    #[test]
    fn chat_spend_counts_toward_per_project() {
        // Audit #74: per_project was populated only from cost_events, so a
        // project whose spend is entirely in-app chat read $0.00 and its
        // budget alert never fired. Chat rows must accumulate per-project too.
        let conn = super::super::mem();
        let p = super::super::add_project(&conn, "/tmp/chat-only", "chat-only", false).unwrap();
        let cs =
            super::super::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", Some(&p.id))
                .unwrap();
        super::super::add_chat_message(
            &conn,
            super::super::NewChatMessage {
                chat_session_id: &cs.id,
                role: "assistant",
                content: "hi",
                input_tokens: Some(1_000_000),
                output_tokens: Some(500_000),
                cost_usd: Some(0.0),
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                reasoning_output_tokens: None,
                provider: Some("anthropic"),
                model_key: None,
                pricing_estimated_usd: None,
                started_at: None,
                completed_at: None,
                llm_time_ms: None,
                tool_time_ms: None,
                ttft_ms: None,
                tokens_per_second: None,
            },
        )
        .unwrap();
        let r = rollups_for_tests(&conn);
        let proj = r
            .per_project
            .iter()
            .find(|x| x.project_id == p.id)
            .expect("chat-only project must appear in per_project");
        // $3/M input + $15/M output → 3.0 + 7.5 = 10.5
        assert!(
            (proj.total_cost_usd - 10.5).abs() < 1e-6,
            "got {}",
            proj.total_cost_usd
        );
        assert_eq!(proj.total_input_tokens, 1_000_000);
        assert_eq!(proj.total_output_tokens, 500_000);
    }

    #[test]
    fn rollup_includes_local_models_in_per_model() {
        let conn = super::super::mem();
        // Local GGUF chat session — model name has no canonical key. The
        // session model is a full file path (GGUF without metadata name);
        // the breakdown must show the basename, not the path.
        let cs = super::super::create_chat_session(
            &conn,
            "local_gguf",
            r"D:\models\qwen2.5-7b-q4_k_m.gguf",
            None,
        )
        .unwrap();
        super::super::add_chat_message(
            &conn,
            super::super::NewChatMessage {
                chat_session_id: &cs.id,
                role: "assistant",
                content: "hi",
                input_tokens: Some(1_000_000),
                output_tokens: Some(500_000),
                cost_usd: Some(0.0),
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                reasoning_output_tokens: None,
                provider: Some("local_gguf"),
                model_key: None,
                pricing_estimated_usd: None,
                started_at: None,
                completed_at: None,
                llm_time_ms: None,
                tool_time_ms: None,
                ttft_ms: None,
                tokens_per_second: None,
            },
        )
        .unwrap();
        let r = rollups_for_tests(&conn);
        // Local models appear in the per-model breakdown under their basename
        // with $0 cost (no API pricing), tokens still counted.
        let local = r
            .per_model
            .iter()
            .find(|m| m.model_key == "qwen2.5-7b-q4_k_m")
            .unwrap();
        assert_eq!(local.cost_usd, 0.0);
        assert_eq!(local.tokens, 1_500_000);
        // Grouped under chat:local_gguf in the per-provider breakdown.
        let prov = r
            .per_provider
            .iter()
            .find(|p| p.provider == "chat:local_gguf")
            .unwrap();
        assert_eq!(prov.tokens, 1_500_000);
        assert_eq!(prov.cost_usd, 0.0);
    }

    #[test]
    fn chat_rows_with_null_provider_group_by_session_provider() {
        let conn = super::super::mem();
        // Legacy chat row: provider column NULL (written before the column
        // existed). The rollup must fall back to the chat session's provider
        // instead of showing "chat:unknown".
        let cs = super::super::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None)
            .unwrap();
        super::super::add_chat_message(
            &conn,
            super::super::NewChatMessage {
                chat_session_id: &cs.id,
                role: "assistant",
                content: "hi",
                input_tokens: Some(100_000),
                output_tokens: Some(50_000),
                cost_usd: Some(0.0),
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                reasoning_output_tokens: None,
                provider: None,
                model_key: None,
                pricing_estimated_usd: None,
                started_at: None,
                completed_at: None,
                llm_time_ms: None,
                tool_time_ms: None,
                ttft_ms: None,
                tokens_per_second: None,
            },
        )
        .unwrap();
        let r = rollups_for_tests(&conn);
        assert!(
            !r.per_provider.iter().any(|p| p.provider == "chat:unknown"),
            "legacy chat row grouped as chat:unknown"
        );
        assert!(r
            .per_provider
            .iter()
            .any(|p| p.provider == "chat:anthropic"));
    }

    #[test]
    fn local_model_electricity_cost_appears_in_rollup() {
        let conn = super::super::mem();
        // 200W GPU, $0.15/kWh rate, 1h duration => $0.03 per row
        crate::db::set_setting(&conn, crate::chat::local_models::GPU_POWER_WATTS_KEY, "200")
            .unwrap();
        crate::db::set_setting(
            &conn,
            crate::chat::local_models::ELECTRICITY_RATE_KEY,
            "0.15",
        )
        .unwrap();
        let cs = super::super::create_chat_session(
            &conn,
            "local_gguf",
            r"D:\models\qwen2.5-7b-q4_k_m.gguf",
            None,
        )
        .unwrap();
        let now = crate::db::now_ts();
        // 1h = 3600s of work
        super::super::add_chat_message(
            &conn,
            super::super::NewChatMessage {
                chat_session_id: &cs.id,
                role: "assistant",
                content: "hi",
                input_tokens: Some(1_000_000),
                output_tokens: Some(500_000),
                cost_usd: Some(0.0),
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                reasoning_output_tokens: None,
                provider: Some("local_gguf"),
                model_key: None,
                pricing_estimated_usd: None,
                started_at: Some(now),
                completed_at: Some(now + 3600),
                llm_time_ms: None,
                tool_time_ms: None,
                ttft_ms: None,
                tokens_per_second: None,
            },
        )
        .unwrap();
        let r = rollups_for_tests(&conn);
        let prov = r
            .per_provider
            .iter()
            .find(|p| p.provider == "chat:local_gguf")
            .unwrap();
        // 200W × 1h × $0.15/kWh / 1000 = $0.03
        assert!((prov.cost_usd - 0.03).abs() < 1e-9, "got {}", prov.cost_usd);
    }

    #[test]
    fn basename_strips_path_and_extension() {
        assert_eq!(
            basename(r"D:\models\qwen2.5-7b-q4_k_m.gguf"),
            "qwen2.5-7b-q4_k_m"
        );
        assert_eq!(basename("/home/u/models/llama-3b.gguf"), "llama-3b");
        // Plain names and dotted-but-short extensions survive untouched.
        assert_eq!(basename("DeepSeek R1 0528"), "DeepSeek R1 0528");
        assert_eq!(basename("my.model.name"), "my.model");
    }

    #[test]
    fn rollup_per_project_is_read_time_priced() {
        let conn = super::super::mem();
        let p = super::super::add_project(&conn, "/tmp/a", "a", false).unwrap();
        let s = super::super::create_session(&conn, &p.id, "claude_code").unwrap();
        // Insert WITHOUT pricing_estimated_usd (NULL — as real on-disk rows
        // are). The per-project rollup must still show the read-time price.
        insert_cost_event(
            &conn,
            &s.id,
            &UsageInfo {
                input_tokens: Some(1_000_000),
                output_tokens: Some(500_000),
                ..Default::default()
            },
            "claude_code",
            "on_disk",
            None,
        )
        .unwrap();
        let r = rollups_for_tests(&conn);
        let proj = r.per_project.iter().find(|x| x.project_id == p.id).unwrap();
        // claude-sonnet-4-5 (harness default): $3/M input, $15/M output → 10.5
        assert!(
            (proj.total_cost_usd - 10.5).abs() < 1e-6,
            "got {}",
            proj.total_cost_usd
        );
        assert_eq!(proj.total_input_tokens, 1_000_000);
        assert_eq!(proj.total_output_tokens, 500_000);
    }
}

pub fn get_cost_rollups(conn: &Connection, range_days: Option<u32>) -> DbResult<CostRollups> {
    get_cost_rollups_v2(conn, range_days.unwrap_or(30))
}
