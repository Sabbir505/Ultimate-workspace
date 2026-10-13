//! Rolling usage windows per provider/harness target — "how much have I used
//! in the last hour / day / week / month".
//!
//! This is the *measured* half of the usage meter (the *reported* half lives
//! in `chat/plan_usage.rs`): it reads the same two sources the cost rollup
//! does (`cost_events` for harness panes, assistant `chat_messages` for
//! in-app chat and harness chat turns) and buckets them into four rolling
//! windows. Identity mirrors `db/cost_v2.rs`: harness ids stay bare
//! (`claude_code`), in-app chat groups as `chat:<provider>`.
//!
//! Cost per bucket is the provider-REPORTED cost when the source carried one,
//! otherwise the same read-time pricing the rollup uses (`read_rate_overrides`
//! + `price_usage`) over the bucket's token sums — no forked math.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;

use crate::harness_adapters::pricing::price_usage;
use crate::harness_adapters::UsageInfo;

/// Rolling window lengths in seconds: 1h, 24h, 7d, 30d.
pub const WINDOW_SECS: [i64; 4] = [3_600, 86_400, 7 * 86_400, 30 * 86_400];

/// Harness CLI ids — a bare id in this list is a harness target, not a chat
/// provider (the two share one namespace in the rollups; keep in sync with
/// `harness_adapters::adapters()`).
pub const HARNESS_IDS: [&str; 6] = [
    "claude_code",
    "kimi_code",
    "opencode",
    "pi",
    "omp",
    "commandcode",
];

pub fn is_harness_id(id: &str) -> bool {
    HARNESS_IDS.contains(&id)
}

/// Friendly label for a rollup identity.
pub fn label_for(target: &str) -> String {
    let known = match target {
        "claude_code" => Some("Claude Code"),
        "kimi_code" => Some("Kimi Code"),
        "opencode" => Some("OpenCode"),
        "opencode_go" => Some("OpenCode Go"),
        "pi" => Some("Pi"),
        "omp" => Some("Omp"),
        "commandcode" => Some("CommandCode"),
        "chat:anthropic" => Some("Anthropic API"),
        "chat:openai" | "chat:openai_chat" => Some("OpenAI API"),
        "chat:openai_responses" => Some("OpenAI (Responses)"),
        "chat:openrouter" => Some("OpenRouter"),
        "chat:anthropic_compatible" => Some("Anthropic-compatible"),
        "chat:openai_compatible" => Some("OpenAI-compatible"),
        "chat:local_gguf" => Some("Local model"),
        _ => None,
    };
    if let Some(k) = known {
        return k.to_string();
    }
    // Unknown chat provider or an acp agent id — capitalize as-is.
    let base = target.strip_prefix("chat:").unwrap_or(target);
    let mut chars = base.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => target.to_string(),
    }
}

/// Map a row's provider column to a meter target. Handles all three spellings
/// that reach the DB: bare harness ids (harness chat turns strip the prefix
/// before writing), `harness:<id>` (chat_sessions.provider), and plain chat
/// providers.
pub fn target_for(provider: Option<&str>) -> Option<String> {
    let p = provider?.trim();
    if p.is_empty() {
        return None;
    }
    if let Some(h) = p.strip_prefix("harness:") {
        return Some(h.to_string());
    }
    if let Some(h) = p.strip_prefix("acp:") {
        return Some(format!("acp:{h}"));
    }
    if is_harness_id(p) {
        return Some(p.to_string());
    }
    Some(format!("chat:{p}"))
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub reasoning_tokens: i64,
    /// Rows counted — a request (cost_events) or a turn (chat_messages).
    pub requests: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterWindows {
    pub last_hour: UsageTotals,
    pub last_day: UsageTotals,
    pub last_week: UsageTotals,
    pub last_month: UsageTotals,
}

impl MeterWindows {
    fn at(&mut self, idx: usize) -> &mut UsageTotals {
        match idx {
            0 => &mut self.last_hour,
            1 => &mut self.last_day,
            2 => &mut self.last_week,
            _ => &mut self.last_month,
        }
    }

    /// Total for a cap window key (`hour` | `day` | `week` | `month`).
    pub fn for_window(&self, window: &str) -> &UsageTotals {
        match window {
            "hour" => &self.last_hour,
            "week" => &self.last_week,
            "month" => &self.last_month,
            _ => &self.last_day,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageMeter {
    pub target: String,
    pub label: String,
    pub windows: MeterWindows,
}

/// One (target, model) bucket within one window — the unit pricing runs on.
#[derive(Default, Clone)]
struct RowAcc {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_creation: i64,
    reasoning: i64,
    requests: i64,
    reported_cost: f64,
}

fn window_index(ts: i64, now: i64) -> Option<usize> {
    let age = now - ts;
    if age < 0 {
        // Future-dated row (clock skew): count it in the newest window.
        return Some(0);
    }
    if age <= WINDOW_SECS[0] {
        Some(0)
    } else if age <= WINDOW_SECS[1] {
        Some(1)
    } else if age <= WINDOW_SECS[2] {
        Some(2)
    } else if age <= WINDOW_SECS[3] {
        Some(3)
    } else {
        None
    }
}

/// Compute rolling meters for every target with activity in the last 30 days.
pub fn compute_usage_meters(conn: &Connection, now: i64) -> Result<Vec<UsageMeter>, String> {
    let overrides = crate::db::cost_v2::read_rate_overrides(conn);
    let since = now - WINDOW_SECS[3];
    // (target, model_key, window_idx) -> accumulator
    let mut acc: HashMap<(String, String, usize), RowAcc> = HashMap::new();

    // Harness pane usage (PTY + on-disk probes).
    {
        let mut stmt = conn
            .prepare(
                "SELECT provider, model_key, timestamp, input_tokens, output_tokens, \
                 cache_creation_input_tokens, cache_read_input_tokens, reasoning_output_tokens, \
                 reported_cost_usd FROM cost_events \
                 WHERE timestamp >= ?1 AND provider IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![since], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<f64>>(8)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (provider, model, ts, input, output, cc, cr, reasoning, reported) =
                row.map_err(|e| e.to_string())?;
            let Some(target) = target_for(provider.as_deref()) else {
                continue;
            };
            let Some(idx) = window_index(ts, now) else {
                continue;
            };
            // The CLI reports no model: fall back to the harness default key
            // (same rule as the rollup) so a priced estimate still exists.
            let model_key = model
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| {
                    crate::harness_adapters::harness_default_model_key(
                        target.strip_prefix("chat:").unwrap_or(&target),
                    )
                    .to_string()
                });
            // A row inside the last hour belongs to EVERY wider window too.
            for w in idx..WINDOW_SECS.len() {
                let e = acc.entry((target.clone(), model_key.clone(), w)).or_default();
                e.input += input.unwrap_or(0);
                e.output += output.unwrap_or(0);
                e.cache_read += cr.unwrap_or(0);
                e.cache_creation += cc.unwrap_or(0);
                e.reasoning += reasoning.unwrap_or(0);
                e.requests += 1;
                e.reported_cost += reported.unwrap_or(0.0);
            }
        }
    }

    // In-app chat + harness chat turns (assistant rows carry usage).
    {
        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(cm.provider, cs.provider) AS provider, cm.model_key, cm.created_at, \
                 cm.input_tokens, cm.output_tokens, cm.cache_creation_input_tokens, \
                 cm.cache_read_input_tokens, cm.reasoning_output_tokens, cm.cost_usd \
                 FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id \
                 WHERE cm.role = 'assistant' AND cm.created_at >= ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![since], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<f64>>(8)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (provider, model, ts, input, output, cc, cr, reasoning, reported) =
                row.map_err(|e| e.to_string())?;
            let Some(target) = target_for(provider.as_deref()) else {
                continue;
            };
            let Some(idx) = window_index(ts, now) else {
                continue;
            };
            let model_key = model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| {
                crate::harness_adapters::harness_default_model_key(
                    target.strip_prefix("chat:").unwrap_or(&target),
                )
                .to_string()
            });
            for w in idx..WINDOW_SECS.len() {
                let e = acc.entry((target.clone(), model_key.clone(), w)).or_default();
                e.input += input.unwrap_or(0);
                e.output += output.unwrap_or(0);
                e.cache_read += cr.unwrap_or(0);
                e.cache_creation += cc.unwrap_or(0);
                e.reasoning += reasoning.unwrap_or(0);
                e.requests += 1;
                e.reported_cost += reported.unwrap_or(0.0);
            }
        }
    }

    // Price each (target, model, window) bucket, then fold into per-target
    // window totals.
    let mut meters: HashMap<String, MeterWindows> = HashMap::new();
    for ((target, model_key, w), a) in acc {
        let cost = if a.reported_cost > 0.0 {
            a.reported_cost
        } else {
            let usage = UsageInfo {
                input_tokens: Some(a.input),
                output_tokens: Some(a.output),
                cache_creation_input_tokens: Some(a.cache_creation),
                cache_read_input_tokens: Some(a.cache_read),
                reasoning_output_tokens: Some(a.reasoning),
                cost_usd: None,
            };
            price_usage(&usage, Some(&model_key), &overrides).unwrap_or(0.0)
        };
        let ww = meters.entry(target).or_default();
        let t = ww.at(w);
        t.input_tokens += a.input;
        t.output_tokens += a.output;
        t.cache_read_tokens += a.cache_read;
        t.cache_creation_tokens += a.cache_creation;
        t.reasoning_tokens += a.reasoning;
        t.requests += a.requests;
        t.cost_usd += cost;
    }

    let mut out: Vec<UsageMeter> = meters
        .into_iter()
        .map(|(target, windows)| UsageMeter {
            label: label_for(&target),
            target,
            windows,
        })
        .collect();
    out.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        conn
    }

    fn add_session(conn: &Connection, id: &str, provider: &str) {
        conn.execute(
            "INSERT INTO chat_sessions (id, provider, model, created_at, last_active_at) \
             VALUES (?1, ?2, 'm', 0, 0)",
            rusqlite::params![id, provider],
        )
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn add_msg(
        conn: &Connection,
        sid: &str,
        created_at: i64,
        provider: Option<&str>,
        input: i64,
        output: i64,
        cost: Option<f64>,
    ) {
        conn.execute(
            "INSERT INTO chat_messages (chat_session_id, role, content, created_at, provider, \
             input_tokens, output_tokens, cost_usd) VALUES (?1, 'assistant', 'x', ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![sid, created_at, provider, input, output, cost],
        )
        .unwrap();
    }

    #[test]
    fn buckets_rolling_windows_per_provider() {
        let conn = test_conn();
        let now = 1_800_000_000;
        add_session(&conn, "c1", "anthropic");
        // 10 minutes ago: counts in every window.
        add_msg(&conn, "c1", now - 600, Some("anthropic"), 100, 10, Some(0.5));
        // 2 days ago: week + month only.
        add_msg(&conn, "c1", now - 2 * 86_400, Some("anthropic"), 200, 20, Some(0.7));
        // 10 days ago: month only.
        add_msg(&conn, "c1", now - 10 * 86_400, Some("anthropic"), 400, 40, Some(1.0));
        // 40 days ago: outside every window.
        add_msg(&conn, "c1", now - 40 * 86_400, Some("anthropic"), 800, 80, Some(2.0));

        let meters = compute_usage_meters(&conn, now).unwrap();
        let m = meters
            .iter()
            .find(|m| m.target == "chat:anthropic")
            .expect("anthropic meter");
        assert_eq!(m.label, "Anthropic API");
        assert_eq!(m.windows.last_hour.requests, 1);
        assert_eq!(m.windows.last_hour.input_tokens, 100);
        assert!((m.windows.last_hour.cost_usd - 0.5).abs() < 1e-9);
        assert_eq!(m.windows.last_day.requests, 1);
        assert_eq!(m.windows.last_week.requests, 2);
        assert_eq!(m.windows.last_month.requests, 3);
        assert_eq!(m.windows.last_month.input_tokens, 700);
        assert!((m.windows.last_month.cost_usd - 2.2).abs() < 1e-9);
    }

    #[test]
    fn harness_sessions_group_under_the_bare_id() {
        let conn = test_conn();
        let now = 1_800_000_000;
        // Harness chat turns write the bare harness id into the message row…
        add_session(&conn, "h1", "harness:claude_code");
        add_msg(&conn, "h1", now - 60, Some("claude_code"), 10, 2, None);
        // …while older rows may carry NULL and lean on the session provider.
        add_msg(&conn, "h1", now - 120, None, 5, 1, None);

        let meters = compute_usage_meters(&conn, now).unwrap();
        let m = meters
            .iter()
            .find(|m| m.target == "claude_code")
            .expect("harness meter");
        assert_eq!(m.windows.last_hour.requests, 2);
        assert_eq!(m.windows.last_hour.input_tokens, 15);
    }

    #[test]
    fn cost_events_price_via_rate_overrides_when_unreported() {
        let conn = test_conn();
        let now = 1_800_000_000;
        conn.execute(
            "INSERT INTO projects (id, path, name, created_at) VALUES ('p1', '.', 'p', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, project_id, harness, created_at, last_active_at) \
             VALUES ('s1','p1','kimi_code',0,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cost_events (session_id, timestamp, input_tokens, output_tokens, provider, model_key) \
             VALUES ('s1', ?1, 2000000, 0, 'kimi_code', 'kimi-k3')",
            rusqlite::params![now - 60],
        )
        .unwrap();
        let meters = compute_usage_meters(&conn, now).unwrap();
        let m = meters.iter().find(|m| m.target == "kimi_code").unwrap();
        assert_eq!(m.windows.last_hour.input_tokens, 2_000_000);
        // Priced (kimi-k3 has a compiled rate) — exact value depends on the
        // rate table, so only assert that a positive estimate exists.
        assert!(m.windows.last_hour.cost_usd > 0.0, "got {}", m.windows.last_hour.cost_usd);
    }

    #[test]
    fn target_mapping_covers_all_spellings() {
        assert_eq!(target_for(Some("anthropic")).as_deref(), Some("chat:anthropic"));
        assert_eq!(target_for(Some("harness:opencode")).as_deref(), Some("opencode"));
        assert_eq!(target_for(Some("commandcode")).as_deref(), Some("commandcode"));
        assert_eq!(target_for(Some("acp:zed")).as_deref(), Some("acp:zed"));
        assert_eq!(target_for(Some("  ")), None);
        assert_eq!(label_for("chat:openai_responses"), "OpenAI (Responses)");
        assert_eq!(label_for("acp:zed"), "Acp:zed");
    }
}
