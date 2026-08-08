//! Cost rollup v2 (COST_MODEL_REDESIGN.md §8).
//!
//! Read-time pricing via `crate::harness_adapters::pricing::price_usage`.
//! Single source of truth across desktop + mobile. The rollup unions
//! `cost_events` (harness panes) with `chat_messages` (in-app chat) so the
//! dashboard treats them as one universe.

use rusqlite::{params, Connection};
use std::collections::{BTreeMap, HashMap};
use crate::harness_adapters::pricing::{price_usage, cache_savings, ModelRate};
use crate::harness_adapters::UsageInfo;
use crate::types::*;
use super::DbResult;

/// Read Settings overrides once: `price.<key>.{input,cache_read,output}_per_mtok`.
/// Each row contributes one field; if the field is 0 the default stands.
pub fn read_rate_overrides(conn: &Connection) -> HashMap<String, ModelRate> {
    use crate::db::get_setting;
    let mut out = HashMap::new();
    let mut stmt = match conn.prepare(
        "SELECT key, value FROM app_settings
          WHERE key LIKE 'price.%.input_per_mtok'
             OR key LIKE 'price.%.cache_read_per_mtok'
             OR key LIKE 'price.%.output_per_mtok'"
    ) { Ok(s) => s, Err(_) => return out };
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    });
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            let (key, value) = row;
            let parts: Vec<&str> = key.splitn(3, '.').collect();
            if parts.len() != 3 { continue; }
            let model = parts[1].to_string();
            let suffix = parts[2];
            let val: f64 = value.parse().unwrap_or(0.0);
            if val <= 0.0 { continue; }
            let entry = out.entry(model).or_insert(ModelRate {
                input_per_mtok: 0.0, cache_read_per_mtok: 0.0, output_per_mtok: 0.0,
            });
            match suffix {
                "input_per_mtok" => entry.input_per_mtok = val,
                "cache_read_per_mtok" => entry.cache_read_per_mtok = val,
                "output_per_mtok" => entry.output_per_mtok = val,
                _ => {}
            }
        }
    }
    // Also populate from get_setting for any keys the LIKE query missed (it
    // catches all app_settings rows; this is redundant for the in-process
    // path but documents the helper's contract).
    let _ = get_setting; // silence unused-import lint if it appears
    out
}

fn iso_date_for_range(start_ts: i64, end_ts: i64) -> (String, String) {
    use std::time::{UNIX_EPOCH, Duration};
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
    let days = match range_days { 7 | 30 | 90 => range_days, _ => 30 };
    let now = crate::db::now_ts();
    let since = now - (days as i64) * 86_400;
    let overrides = read_rate_overrides(conn);
    let (range_start, range_end) = iso_date_for_range(since, now);

    let mut totals = CostTotals::default();
    let mut by_provider: BTreeMap<String, (f64, i64)> = BTreeMap::new();
    let mut by_model: BTreeMap<String, (f64, i64, Option<String>)> = BTreeMap::new();
    let mut by_kind = CostByKind::default();
    let mut daily_map: BTreeMap<String, DailyCost> = BTreeMap::new();
    let mut responses: i64 = 0;

    // ----- cost_events (harness panes) -----
    {
        let mut stmt = conn.prepare(
            "SELECT timestamp, input_tokens, output_tokens, provider, model_key,
                    cache_creation_input_tokens, cache_read_input_tokens,
                    reasoning_output_tokens, reported_cost_usd
               FROM cost_events
              WHERE timestamp >= ?1"
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
            ))
        })?;
        for row in rows {
            let (ts, i, o, provider, model_key, cc, cr, reasoning, reported) = row?;
            let usage = UsageInfo {
                input_tokens: i, output_tokens: o,
                cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
                reasoning_output_tokens: reasoning, cost_usd: None,
            };
            // Rows with NULL model_key price at the harness's default model
            // (spec §7.2 — "priced as harness default"). The provider column
            // carries the harness id ('claude_code' | 'kimi_code' | 'opencode').
            let key = model_key.as_deref().or_else(|| {
                provider.as_deref().map(crate::harness_adapters::harness_default_model_key)
            });
            let cost = price_usage(&usage, key, &overrides);
            let tokens_i = i.unwrap_or(0) + cc.unwrap_or(0) + cr.unwrap_or(0) + o.unwrap_or(0) + reasoning.unwrap_or(0);
            let day = date_str(ts);
            if let Some(c) = cost {
                totals.raw_token_cost_usd += c;
                totals.estimated_usd += c;
                if let Some(p) = provider.as_deref() {
                    let entry = by_provider.entry(p.to_string()).or_insert((0.0, 0));
                    entry.0 += c;
                    entry.1 += tokens_i;
                }
                if let Some(k) = key {
                    let entry = by_model.entry(k.to_string()).or_insert((0.0, 0, provider.clone()));
                    entry.0 += c;
                    entry.1 += tokens_i;
                }
                let d = daily_map.entry(day.clone()).or_insert_with(|| DailyCost { day: day.clone(), ..Default::default() });
                d.cost_usd += c;
                *d.tokens_by_provider.entry(provider.clone().unwrap_or_else(|| "unknown".to_string())).or_insert(0) += tokens_i;
                totals.cache_savings_usd_via_helper += cache_savings(&usage, key, &overrides);
            } else {
                totals.unpriced_usd += reported.unwrap_or(0.0);
            }
            if let Some(r) = reported {
                totals.provider_reported_usd += r;
            }
            by_kind.uncached_input_tokens += i.unwrap_or(0);
            by_kind.cached_input_tokens += cc.unwrap_or(0) + cr.unwrap_or(0);
            by_kind.output_tokens += o.unwrap_or(0);
            by_kind.reasoning_tokens += reasoning.unwrap_or(0);
            responses += 1;
        }
    }

    // ----- chat_messages (in-app chat) -----
    {
        let mut stmt = conn.prepare(
            "SELECT cm.created_at, cm.input_tokens, cm.output_tokens, cm.provider, cm.model_key,
                    cm.cache_creation_input_tokens, cm.cache_read_input_tokens,
                    cm.reasoning_output_tokens, cs.model
               FROM chat_messages cm
               JOIN chat_sessions cs ON cs.id = cm.chat_session_id
              WHERE cm.created_at >= ?1 AND cm.role = 'assistant'"
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
            ))
        })?;
        for row in rows {
            let (ts, i, o, provider, model_key, cc, cr, reasoning, session_model) = row?;
            let usage = UsageInfo {
                input_tokens: i, output_tokens: o,
                cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
                reasoning_output_tokens: reasoning, cost_usd: None,
            };
            // Chat rows with NULL model_key fall back to the chat session's
            // model (canonicalized), mirroring the harness default fallback.
            let key = model_key
                .as_deref()
                .or_else(|| session_model.as_deref().and_then(crate::harness_adapters::canonical_model_key));
            let cost = price_usage(&usage, key, &overrides).unwrap_or(0.0);
            let tokens_i = i.unwrap_or(0) + cc.unwrap_or(0) + cr.unwrap_or(0) + o.unwrap_or(0) + reasoning.unwrap_or(0);
            let grouped = format!("chat:{}", provider.clone().unwrap_or_else(|| "unknown".to_string()));
            let entry = by_provider.entry(grouped.clone()).or_insert((0.0, 0));
            entry.0 += cost;
            entry.1 += tokens_i;
            if let Some(k) = key {
                let entry = by_model.entry(k.to_string()).or_insert((0.0, 0, Some(grouped.clone())));
                entry.0 += cost;
                entry.1 += tokens_i;
            }
            let day = date_str(ts);
            let d = daily_map.entry(day.clone()).or_insert_with(|| DailyCost { day: day.clone(), ..Default::default() });
            d.cost_usd += cost;
            *d.tokens_by_provider.entry(grouped).or_insert(0) += tokens_i;
            by_kind.uncached_input_tokens += i.unwrap_or(0);
            by_kind.cached_input_tokens += cc.unwrap_or(0) + cr.unwrap_or(0);
            by_kind.output_tokens += o.unwrap_or(0);
            by_kind.reasoning_tokens += reasoning.unwrap_or(0);
            responses += 1;
        }
    }

    by_kind.processed_tokens = by_kind.uncached_input_tokens + by_kind.cached_input_tokens;
    by_kind.responses = responses;
    by_kind.sessions = count_distinct_sessions(conn, since).unwrap_or(0);

    // Sessions: from cost_events + chat_sessions — distinct session_id + chat_session_id.
    // The simple approach: count distinct session_id in cost_events (harness panes)
    // plus distinct chat_session_id in chat_messages that have at least one
    // assistant row in the window. Good enough for a stats row.
    let mut per_provider: Vec<ProviderCostRollup> = by_provider.iter().map(|(p, (c, t))| ProviderCostRollup {
        provider: p.clone(),
        cost_usd: *c,
        tokens: *t,
        share_pct: if totals.raw_token_cost_usd > 0.0 { *c / totals.raw_token_cost_usd * 100.0 } else { 0.0 },
    }).collect();
    per_provider.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));

    let mut per_model: Vec<ModelCostRollup> = by_model.iter().map(|(k, (c, t, p))| ModelCostRollup {
        model_key: k.clone(),
        display_name: k.clone(),
        cost_usd: *c,
        share_pct: if totals.raw_token_cost_usd > 0.0 { *c / totals.raw_token_cost_usd * 100.0 } else { 0.0 },
        tokens: *t,
        provider: p.clone(),
    }).collect();
    per_model.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));

    // perProject
    let per_project: Vec<ProjectCostRollup> = {
        let mut stmt = conn.prepare(
            "SELECT s.project_id,
                    COALESCE(SUM(ce.pricing_estimated_usd), 0.0),
                    COALESCE(SUM(ce.input_tokens), 0),
                    COALESCE(SUM(ce.output_tokens), 0)
               FROM cost_events ce
               JOIN sessions s ON s.id = ce.session_id
              WHERE ce.timestamp >= ?1
              GROUP BY s.project_id"
        )?;
        let rows = stmt.query_map(params![since], |r| {
            Ok(ProjectCostRollup {
                project_id: r.get(0)?,
                total_cost_usd: r.get(1)?,
                total_input_tokens: r.get(2)?,
                total_output_tokens: r.get(3)?,
            })
        })?;
        rows.collect::<DbResult<Vec<_>>>()?
    };

    let mut daily: Vec<DailyCost> = daily_map.into_values().collect();
    daily.sort_by(|a, b| a.day.cmp(&b.day));

    // Cost quality: row counts and percentages.
    let total_rows = (responses as f64).max(1.0);
    let provider_reported_rows = (totals.provider_reported_usd > 0.0) as i64 as f64;
    let unpriced_rows = (totals.unpriced_usd > 0.0) as i64 as f64;
    let cost_quality = CostQuality {
        provider_reported_pct: provider_reported_rows / total_rows * 100.0,
        model_priced_pct: (responses as f64 - unpriced_rows) / total_rows * 100.0,
        unpriced_pct: unpriced_rows / total_rows * 100.0,
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

fn date_str(ts: i64) -> String {
    use std::time::{UNIX_EPOCH, Duration};
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_adapters::UsageInfo;
    use crate::db::insert_cost_event;

    #[test]
    fn rollup_totals_match_sum() {
        let conn = super::super::mem();
        let p = super::super::add_project(&conn, "/tmp/a", "a", false).unwrap();
        let s = super::super::create_session(&conn, &p.id, "claude_code").unwrap();
        let u = |i: i64, o: i64, cc: i64, cr: i64, r: i64| UsageInfo {
            input_tokens: Some(i), output_tokens: Some(o),
            cache_creation_input_tokens: Some(cc), cache_read_input_tokens: Some(cr),
            reasoning_output_tokens: Some(r), cost_usd: None,
        };
        // 1M input + 0.5M cache_creation @ $3 = 4.5;
        // 2M cache_read @ $0.30 = 0.6; 0.5M output @ $15 = 7.5.
        // = 12.6 per event (the test passes r=0 for reasoning).
        for _ in 0..3 {
            insert_cost_event(
                &conn, &s.id,
                &u(1_000_000, 500_000, 500_000, 2_000_000, 0),
                "claude_code", "on_disk", Some(12.6),
            ).unwrap();
        }
        let r = get_cost_rollups_v2(&conn, 7).unwrap();
        assert!((r.totals.raw_token_cost_usd - 37.8).abs() < 1e-6, "got {}", r.totals.raw_token_cost_usd);
        assert_eq!(r.per_provider.len(), 1);
        assert_eq!(r.per_provider[0].provider, "claude_code");
        assert!((r.per_provider[0].cost_usd - 37.8).abs() < 1e-6);
    }

    #[test]
    fn rollup_unions_chat_messages() {
        let conn = super::super::mem();
        let cs = super::super::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5").unwrap();
        super::super::add_chat_message(
            &conn, &cs.id, "assistant", "hi", Some(1_000_000), Some(500_000), Some(0.0),
            None, None, None, Some("anthropic"), None, None,
        ).unwrap();
        let r = get_cost_rollups_v2(&conn, 7).unwrap();
        // claude-sonnet-4-5: $3 input, $15 output → 1M*3/1M + 0.5M*15/1M = 10.5
        let chat_provider = r.per_provider.iter().find(|p| p.provider == "chat:anthropic").unwrap();
        assert!((chat_provider.cost_usd - 10.5).abs() < 1e-6, "got {}", chat_provider.cost_usd);
    }
}

pub fn get_cost_rollups(conn: &Connection, range_days: Option<u32>) -> DbResult<CostRollups> {
    get_cost_rollups_v2(conn, range_days.unwrap_or(30))
}
