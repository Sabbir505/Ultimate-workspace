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
            // Key shape: "price.<model>.<suffix>". Model keys may contain dots
            // (e.g. "kimi-k2.7-code"), so split on the LAST dot, not the
            // second one.
            let Some((prefix, suffix)) = key.rsplit_once('.') else { continue };
            let Some(model) = prefix.strip_prefix("price.") else { continue };
            let val: f64 = value.parse().unwrap_or(0.0);
            if val <= 0.0 { continue; }
            let entry = out.entry(model.to_string()).or_insert(ModelRate {
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
    // Any positive range is valid here — the 7|30|90 whitelist lives at the
    // IPC boundary (commands/data.rs) so the mobile relay can ask for 14 days.
    let days = range_days.max(1);
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
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        rows.collect::<DbResult<HashMap<_, _>>>()?
    };
    let mut by_project: BTreeMap<String, (f64, i64, i64)> = BTreeMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT timestamp, input_tokens, output_tokens, provider, model_key,
                    cache_creation_input_tokens, cache_read_input_tokens,
                    reasoning_output_tokens, reported_cost_usd, session_id
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
                r.get::<_, String>(9)?,
            ))
        })?;
        for row in rows {
            let (ts, i, o, provider, model_key, cc, cr, reasoning, reported, sid) = row?;
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
                    let entry = by_model.entry(k.to_string()).or_insert((0.0, 0, provider.clone()));
                    entry.0 += c;
                    entry.1 += tokens_i;
                }
                let d = daily_map.entry(day.clone()).or_insert_with(|| DailyCost { day: day.clone(), ..Default::default() });
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
        // otherwise show as "chat:unknown".
        let mut stmt = conn.prepare(
            "SELECT cm.created_at, cm.input_tokens, cm.output_tokens,
                    COALESCE(cm.provider, cs.provider) AS provider, cm.model_key,
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
            let cost = price_usage(&usage, key, &overrides);
            let tokens_i = i.unwrap_or(0) + cc.unwrap_or(0) + cr.unwrap_or(0) + o.unwrap_or(0) + reasoning.unwrap_or(0);
            let grouped = format!("chat:{}", provider.clone().unwrap_or_else(|| "unknown".to_string()));
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
            let entry = by_model.entry(model_label).or_insert((0.0, 0, Some(grouped.clone())));
            entry.0 += c;
            entry.1 += tokens_i;
            let day = date_str(ts);
            let d = daily_map.entry(day.clone()).or_insert_with(|| DailyCost { day: day.clone(), ..Default::default() });
            d.cost_usd += c;
            *d.tokens_by_provider.entry(grouped.clone()).or_insert(0) += tokens_i;
            *d.cost_by_provider.entry(grouped).or_insert(0.0) += c;
            totals.cache_savings_usd_via_helper += cache_savings(&usage, key, &overrides);
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

    // perProject — read-time priced (accumulated in the cost_events loop above;
    // never the write-only pricing_estimated_usd column, spec §7).
    let per_project: Vec<ProjectCostRollup> = by_project.iter().map(|(pid, (c, ti, to))| ProjectCostRollup {
        project_id: pid.clone(),
        total_cost_usd: *c,
        total_input_tokens: *ti,
        total_output_tokens: *to,
    }).collect();

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
        Some((stem, ext)) if !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric()) => stem.to_string(),
        _ => leaf.to_string(),
    }
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
        let cs = super::super::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        super::super::add_chat_message(
            &conn, &cs.id, "assistant", "hi", Some(1_000_000), Some(500_000), Some(0.0),
            None, None, None, Some("anthropic"), None, None,
        ).unwrap();
        let r = get_cost_rollups_v2(&conn, 7).unwrap();
        // claude-sonnet-4-5: $3 input, $15 output → 1M*3/1M + 0.5M*15/1M = 10.5
        let chat_provider = r.per_provider.iter().find(|p| p.provider == "chat:anthropic").unwrap();
        assert!((chat_provider.cost_usd - 10.5).abs() < 1e-6, "got {}", chat_provider.cost_usd);
        // The hero total must include chat rows (spec §8: per-provider shares
        // sum to rawTokenCostUsd). Regression for the missing-totals bug.
        assert!((r.totals.raw_token_cost_usd - 10.5).abs() < 1e-6, "got {}", r.totals.raw_token_cost_usd);
        assert!((r.daily.iter().map(|d| d.cost_usd).sum::<f64>() - 10.5).abs() < 1e-6);
        // Cost-quality %s are row counts and sum to 100 (spec §13.3).
        assert!((r.cost_quality.provider_reported_pct + r.cost_quality.model_priced_pct + r.cost_quality.unpriced_pct - 100.0).abs() < 1e-6);
    }

    #[test]
    fn rollup_includes_local_models_in_per_model() {
        let conn = super::super::mem();
        // Local GGUF chat session — model name has no canonical key. The
        // session model is a full file path (GGUF without metadata name);
        // the breakdown must show the basename, not the path.
        let cs = super::super::create_chat_session(
            &conn, "local_gguf", r"D:\models\qwen2.5-7b-q4_k_m.gguf", None,
        ).unwrap();
        super::super::add_chat_message(
            &conn, &cs.id, "assistant", "hi", Some(1_000_000), Some(500_000), Some(0.0),
            None, None, None, Some("local_gguf"), None, None,
        ).unwrap();
        let r = get_cost_rollups_v2(&conn, 7).unwrap();
        // Local models appear in the per-model breakdown under their basename
        // with $0 cost (no API pricing), tokens still counted.
        let local = r.per_model.iter().find(|m| m.model_key == "qwen2.5-7b-q4_k_m").unwrap();
        assert_eq!(local.cost_usd, 0.0);
        assert_eq!(local.tokens, 1_500_000);
        // Grouped under chat:local_gguf in the per-provider breakdown.
        let prov = r.per_provider.iter().find(|p| p.provider == "chat:local_gguf").unwrap();
        assert_eq!(prov.tokens, 1_500_000);
        assert_eq!(prov.cost_usd, 0.0);
    }

    #[test]
    fn chat_rows_with_null_provider_group_by_session_provider() {
        let conn = super::super::mem();
        // Legacy chat row: provider column NULL (written before the column
        // existed). The rollup must fall back to the chat session's provider
        // instead of showing "chat:unknown".
        let cs = super::super::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        super::super::add_chat_message(
            &conn, &cs.id, "assistant", "hi", Some(100_000), Some(50_000), Some(0.0),
            None, None, None, None, None, None, // provider = NULL, model_key = NULL
        ).unwrap();
        let r = get_cost_rollups_v2(&conn, 7).unwrap();
        assert!(
            !r.per_provider.iter().any(|p| p.provider == "chat:unknown"),
            "legacy chat row grouped as chat:unknown"
        );
        assert!(r.per_provider.iter().any(|p| p.provider == "chat:anthropic"));
    }

    #[test]
    fn basename_strips_path_and_extension() {
        assert_eq!(basename(r"D:\models\qwen2.5-7b-q4_k_m.gguf"), "qwen2.5-7b-q4_k_m");
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
            &conn, &s.id,
            &UsageInfo { input_tokens: Some(1_000_000), output_tokens: Some(500_000), ..Default::default() },
            "claude_code", "on_disk", None,
        ).unwrap();
        let r = get_cost_rollups_v2(&conn, 7).unwrap();
        let proj = r.per_project.iter().find(|x| x.project_id == p.id).unwrap();
        // claude-sonnet-4-5 (harness default): $3/M input, $15/M output → 10.5
        assert!((proj.total_cost_usd - 10.5).abs() < 1e-6, "got {}", proj.total_cost_usd);
        assert_eq!(proj.total_input_tokens, 1_000_000);
        assert_eq!(proj.total_output_tokens, 500_000);
    }
}

pub fn get_cost_rollups(conn: &Connection, range_days: Option<u32>) -> DbResult<CostRollups> {
    get_cost_rollups_v2(conn, range_days.unwrap_or(30))
}
