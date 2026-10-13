//! Usage & limits: user-configured caps per provider/harness, the rolling
//! usage meters, and the 80%/100% alert engine behind the composer notch.
//!
//! Mirrors `commands/budget.rs` (advisory only — a warning never aborts a
//! turn; the shipped `usage_limit` error path handles actual refusals):
//! config lives as JSON in `app_settings` (`usage.config`), a 5-minute
//! backend tick + frontend `cost:updated` checks produce `usage:limit-alert`
//! events, and tier escalations are deduped per rolling window so the user is
//! told once per tier per window.
//!
//! `get_usage_meters` merges three sources per target: local rolling windows
//! (`db/usage.rs`), configured caps, and provider/CLI-reported windows
//! (`chat/plan_usage.rs`) — a row exists for every target with usage OR a
//! configured cap.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::chat::plan_usage::{self, PlanSnapshot, RateWindow, RefreshReport};
use crate::db;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// App-settings key holding the JSON `Vec<UsageLimitConfig>`.
const USAGE_CONFIG_KEY: &str = "usage.config";
/// App-settings key holding the alert tier-dedup state.
const USAGE_ALERT_STATE_KEY: &str = "usage.alert.state";
/// Default percent at which a cap warns (the user's ask: 80%).
const DEFAULT_THRESHOLD_PCT: f64 = 80.0;
/// Percent at which a provider-reported window warns.
const REPORTED_WARN_PCT: f64 = 80.0;

fn default_threshold_pct() -> f64 {
    DEFAULT_THRESHOLD_PCT
}

/// One configured cap. `window` is a ROLLING window key: `hour` | `day` |
/// `week` | `month` (well-defined without provider reset semantics).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitConfig {
    /// Rollup identity: `chat:<provider>` or a bare harness id.
    pub target: String,
    pub window: String,
    #[serde(default)]
    pub cap_usd: Option<f64>,
    #[serde(default)]
    pub cap_tokens: Option<i64>,
    #[serde(default)]
    pub cap_requests: Option<i64>,
    #[serde(default = "default_threshold_pct")]
    pub threshold_pct: f64,
}

impl UsageLimitConfig {
    fn has_cap(&self) -> bool {
        self.cap_usd.filter(|v| *v > 0.0).is_some()
            || self.cap_tokens.filter(|v| *v > 0).is_some()
            || self.cap_requests.filter(|v| *v > 0).is_some()
    }

    fn window_secs(&self) -> i64 {
        match self.window.as_str() {
            "hour" => 3_600,
            "week" => 7 * 86_400,
            "month" => 30 * 86_400,
            _ => 86_400,
        }
    }
}

/// A cap evaluated against the current rolling window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCapState {
    pub window: String,
    pub used_pct: f64,
    pub used_usd: Option<f64>,
    pub cap_usd: Option<f64>,
    pub used_tokens: Option<i64>,
    pub cap_tokens: Option<i64>,
    pub used_requests: Option<i64>,
    pub cap_requests: Option<i64>,
    pub threshold_pct: f64,
    /// `ok` | `warn` | `crit`.
    pub tier: String,
}

/// One row of the Cost dashboard's Usage & limits panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageMeterPayload {
    pub target: String,
    pub label: String,
    pub windows: db::MeterWindows,
    pub caps: Vec<UsageCapState>,
    pub reported: Vec<RateWindow>,
    pub plan: Option<PlanSnapshot>,
    /// From `chat/model_health.rs` — "out of credit / spend cap reached", etc.
    pub health: Option<String>,
}

/// Emitted on `usage:limit-alert` (tier escalations only).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitAlert {
    pub target: String,
    pub label: String,
    /// `warn` | `crit`.
    pub tier: String,
    pub window: String,
    pub window_label: String,
    pub used_pct: f64,
    pub used_usd: Option<f64>,
    pub cap_usd: Option<f64>,
    pub used_tokens: Option<i64>,
    pub cap_tokens: Option<i64>,
    pub used_requests: Option<i64>,
    pub cap_requests: Option<i64>,
    pub resets_at: Option<i64>,
    pub message: String,
}

// ------------------------------------------------------------------- config

fn load_config(conn: &Connection) -> Vec<UsageLimitConfig> {
    match db::get_setting(conn, USAGE_CONFIG_KEY) {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn save_config(conn: &Connection, config: &[UsageLimitConfig]) -> Result<(), String> {
    let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
    db::set_setting(conn, USAGE_CONFIG_KEY, &json).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ commands

#[tauri::command(async)]
pub fn list_usage_limits(db: State<'_, DbState>) -> CmdResult<Vec<UsageLimitConfig>> {
    let conn = db.0.lock();
    Ok(load_config(&conn))
}

/// Upsert a cap. All cap fields unset/zero clears the entry.
#[tauri::command(async)]
pub fn set_usage_limit(
    db: State<'_, DbState>,
    target: String,
    window: String,
    cap_usd: Option<f64>,
    cap_tokens: Option<i64>,
    cap_requests: Option<i64>,
    threshold_pct: Option<f64>,
) -> CmdResult<UsageLimitConfig> {
    let conn = db.0.lock();
    let mut config = load_config(&conn);
    let window = match window.as_str() {
        "hour" | "day" | "week" | "month" => window,
        _ => "day".to_string(),
    };
    let cfg = UsageLimitConfig {
        target: target.clone(),
        window: window.clone(),
        cap_usd: cap_usd.filter(|v| *v > 0.0),
        cap_tokens: cap_tokens.filter(|v| *v > 0),
        cap_requests: cap_requests.filter(|v| *v > 0),
        threshold_pct: threshold_pct
            .unwrap_or_else(default_threshold_pct)
            .clamp(1.0, 100.0),
    };
    config.retain(|c| !(c.target == target && c.window == window));
    if cfg.has_cap() {
        config.push(cfg.clone());
    }
    save_config(&conn, &config)?;
    Ok(cfg)
}

#[tauri::command(async)]
pub fn remove_usage_limit(db: State<'_, DbState>, target: String, window: String) -> CmdResult<()> {
    let conn = db.0.lock();
    let mut config = load_config(&conn);
    config.retain(|c| !(c.target == target && c.window == window));
    save_config(&conn, &config)?;
    Ok(())
}

#[tauri::command(async)]
pub fn get_usage_meters(db: State<'_, DbState>) -> CmdResult<Vec<UsageMeterPayload>> {
    let conn = db.0.lock();
    Ok(build_meters(&conn, db::now_ts())?)
}

#[tauri::command]
pub async fn check_usage_limits(
    app: AppHandle,
    db: State<'_, DbState>,
) -> CmdResult<Vec<UsageLimitAlert>> {
    Ok(run_usage_limit_checks(app, Arc::clone(&db.0)).await)
}

/// Refresh the provider/CLI plan sources (CommandCode, OpenCode Go,
/// OpenRouter credits). `force` defaults to true (the panel's explicit
/// Refresh button); the Cost dashboard's OPEN passes false so simply viewing
/// the dashboard picks up data fresher than the 10-minute backend throttle
/// without hammering the providers on every visit.
#[tauri::command]
pub async fn refresh_usage_windows(
    app: AppHandle,
    force: Option<bool>,
) -> CmdResult<RefreshReport> {
    Ok(plan_usage::refresh(&app, force.unwrap_or(true)).await)
}

// ------------------------------------------------------------------ builders

fn build_meters(conn: &Connection, now: i64) -> Result<Vec<UsageMeterPayload>, String> {
    let meters = db::compute_usage_meters(conn, now)?;
    let config = load_config(conn);
    let windows_state = plan_usage::read(conn);

    let mut out: Vec<UsageMeterPayload> = Vec::new();
    for m in meters {
        if is_limitless_target(&m.target) {
            continue;
        }
        let caps = config
            .iter()
            .filter(|c| c.target == m.target && c.has_cap())
            .map(|c| cap_state(c, &m.windows))
            .collect();
        let reported = windows_state
            .windows
            .iter()
            .filter(|w| w.target == m.target)
            .cloned()
            .collect();
        let plan = windows_state
            .plans
            .iter()
            .find(|p| p.target == m.target)
            .cloned();
        let health = provider_health(conn, &m.target, now);
        out.push(UsageMeterPayload {
            target: m.target,
            label: m.label,
            windows: m.windows,
            caps,
            reported,
            plan,
            health,
        });
    }

    // Configured targets with no observed usage yet still get a row, so a cap
    // can be configured (and shown) before the first turn.
    for c in config
        .iter()
        .filter(|c| c.has_cap() && !is_limitless_target(&c.target))
    {
        if out.iter().any(|m| m.target == c.target) {
            continue;
        }
        let empty = db::MeterWindows::default();
        let caps = vec![cap_state(c, &empty)];
        let reported = windows_state
            .windows
            .iter()
            .filter(|w| w.target == c.target)
            .cloned()
            .collect();
        let plan = windows_state
            .plans
            .iter()
            .find(|p| p.target == c.target)
            .cloned();
        out.push(UsageMeterPayload {
            target: c.target.clone(),
            label: db::label_for(&c.target),
            windows: empty,
            caps,
            reported,
            plan,
            health: provider_health(conn, &c.target, now),
        });
    }

    out.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(out)
}

/// Targets with no limit model at all are excluded from the Usage & limits
/// surfaces: local GGUF models run on the user's own hardware and have no
/// quota/window to meter against, so a row for them is pure noise (the Cost
/// dashboard's own panels still show their spend).
fn is_limitless_target(target: &str) -> bool {
    matches!(target, "chat:local_gguf")
}

fn provider_health(conn: &Connection, target: &str, now: i64) -> Option<String> {
    let provider = target.strip_prefix("chat:")?;
    crate::chat::model_health::provider_excluded(conn, provider, now)
}

fn total_tokens(t: &db::UsageTotals) -> i64 {
    t.input_tokens
        + t.output_tokens
        + t.cache_read_tokens
        + t.cache_creation_tokens
        + t.reasoning_tokens
}

fn cap_state(c: &UsageLimitConfig, windows: &db::MeterWindows) -> UsageCapState {
    let t = windows.for_window(&c.window);
    let mut pct: f64 = 0.0;
    if let Some(cap) = c.cap_usd.filter(|v| *v > 0.0) {
        pct = pct.max(t.cost_usd / cap * 100.0);
    }
    if let Some(cap) = c.cap_tokens.filter(|v| *v > 0) {
        pct = pct.max(total_tokens(t) as f64 / cap as f64 * 100.0);
    }
    if let Some(cap) = c.cap_requests.filter(|v| *v > 0) {
        pct = pct.max(t.requests as f64 / cap as f64 * 100.0);
    }
    let tier = if pct >= 100.0 {
        "crit"
    } else if pct >= c.threshold_pct {
        "warn"
    } else {
        "ok"
    };
    UsageCapState {
        window: c.window.clone(),
        used_pct: pct,
        used_usd: c.cap_usd.is_some().then_some(t.cost_usd),
        cap_usd: c.cap_usd,
        used_tokens: c.cap_tokens.is_some().then(|| total_tokens(t)),
        cap_tokens: c.cap_tokens,
        used_requests: c.cap_requests.is_some().then_some(t.requests),
        cap_requests: c.cap_requests,
        threshold_pct: c.threshold_pct,
        tier: tier.to_string(),
    }
}

fn window_label(window: &str) -> &'static str {
    match window {
        "hour" => "hourly",
        "week" => "weekly",
        "month" => "monthly",
        _ => "daily",
    }
}

fn tier_rank(tier: &str) -> u8 {
    match tier {
        "crit" => 2,
        "warn" => 1,
        _ => 0,
    }
}

/// 410_000 → "410K", 1_250_000 → "1.2M". The notch renders cap messages
/// verbatim, so a raw token count reads as noise next to the pretty panel.
fn short_tokens(n: i64) -> String {
    if n >= 1_000_000 {
        let m = n as f64 / 1_000_000.0;
        if (m.fract()).abs() < 0.05 { format!("{m:.0}M") } else { format!("{m:.1}M") }
    } else if n >= 1_000 {
        let k = n as f64 / 1_000.0;
        if (k.fract()).abs() < 0.05 { format!("{k:.0}K") } else { format!("{k:.1}K") }
    } else {
        n.to_string()
    }
}

fn cap_alert(c: &UsageLimitConfig, label: &str, windows: &db::MeterWindows) -> Option<UsageLimitAlert> {
    if !c.has_cap() {
        return None;
    }
    let state = cap_state(c, windows);
    if state.tier == "ok" {
        return None;
    }
    let detail = if let (Some(used), Some(cap)) = (state.used_usd, state.cap_usd) {
        format!("${used:.2} / ${cap:.2}")
    } else if let (Some(used), Some(cap)) = (state.used_tokens, state.cap_tokens) {
        format!("{} / {} tokens", short_tokens(used), short_tokens(cap))
    } else if let (Some(used), Some(cap)) = (state.used_requests, state.cap_requests) {
        format!("{used} / {cap} requests")
    } else {
        String::new()
    };
    let message = if state.tier == "crit" {
        format!(
            "{label} reached its {} cap ({detail})",
            window_label(&c.window)
        )
    } else {
        format!(
            "{label} at {:.0}% of its {} cap ({detail})",
            state.used_pct,
            window_label(&c.window)
        )
    };
    Some(UsageLimitAlert {
        target: c.target.clone(),
        label: label.to_string(),
        tier: state.tier.clone(),
        window: c.window.clone(),
        window_label: window_label(&c.window).to_string(),
        used_pct: state.used_pct,
        used_usd: state.used_usd,
        cap_usd: state.cap_usd,
        used_tokens: state.used_tokens,
        cap_tokens: state.cap_tokens,
        used_requests: state.used_requests,
        cap_requests: state.cap_requests,
        resets_at: None,
        message,
    })
}

fn reported_alert(w: &RateWindow, label: &str) -> Option<UsageLimitAlert> {
    let pct = w.used_pct?;
    let exceeded = w.status.as_deref() == Some("exceeded") || pct >= 100.0;
    let tier = if exceeded {
        "crit"
    } else if pct >= REPORTED_WARN_PCT {
        "warn"
    } else {
        return None;
    };
    let message = match (&w.unit[..], w.remaining) {
        ("usd", Some(left)) => format!("{label}: {} at {:.0}% used — ${left:.2} left", w.label, pct),
        _ => format!("{label}: {} at {:.0}% used", w.label, pct),
    };
    Some(UsageLimitAlert {
        target: w.target.clone(),
        label: label.to_string(),
        tier: tier.to_string(),
        window: w.window.clone(),
        window_label: w.label.clone(),
        used_pct: pct,
        used_usd: (w.unit == "usd").then_some(w.used).flatten(),
        cap_usd: (w.unit == "usd").then_some(w.limit).flatten(),
        used_tokens: (w.unit == "tokens").then_some(w.used).flatten().map(|v| v as i64),
        cap_tokens: (w.unit == "tokens").then_some(w.limit).flatten().map(|v| v as i64),
        used_requests: (w.unit == "requests").then_some(w.used).flatten().map(|v| v as i64),
        cap_requests: (w.unit == "requests").then_some(w.limit).flatten().map(|v| v as i64),
        resets_at: w.resets_at,
        message,
    })
}

/// Current alerts (every target in warn/crit) + the tier-escalation dedup.
fn compute_alerts(
    conn: &Connection,
    now: i64,
) -> Result<(Vec<UsageLimitAlert>, Vec<UsageLimitAlert>), String> {
    let meters = db::compute_usage_meters(conn, now)?;
    let config = load_config(conn);
    let windows_state = plan_usage::read(conn);

    let mut current: Vec<UsageLimitAlert> = Vec::new();
    // Caps first (the user's own numbers), then provider-reported windows.
    // Limitless targets (local models) are skipped here too — no rows in the
    // panel and no alerts for them.
    for c in config
        .iter()
        .filter(|c| c.has_cap() && !is_limitless_target(&c.target))
    {
        let empty = db::MeterWindows::default();
        let windows = meters
            .iter()
            .find(|m| m.target == c.target)
            .map(|m| &m.windows)
            .unwrap_or(&empty);
        let label = db::label_for(&c.target);
        if let Some(a) = cap_alert(c, &label, windows) {
            current.push(a);
        }
    }
    for w in windows_state
        .windows
        .iter()
        .filter(|w| !is_limitless_target(&w.target))
    {
        let label = db::label_for(&w.target);
        if let Some(a) = reported_alert(w, &label) {
            current.push(a);
        }
    }

    // Dedup: one notification per tier escalation per ROLLING window. The
    // bucket rolls over (resets_at for reported windows, window length for
    // caps), so the next episode notifies again.
    let mut state: HashMap<String, (String, String)> = db::get_setting(conn, USAGE_ALERT_STATE_KEY)
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let mut fresh: HashMap<String, (String, String)> = HashMap::new();
    let mut escalated: Vec<UsageLimitAlert> = Vec::new();
    for a in &current {
        let key = format!("{}|{}|{}", a.target, a.window, a.window_label);
        let bucket = match a.resets_at {
            Some(ts) => ts.to_string(),
            None => {
                let secs = match a.window.as_str() {
                    "hour" => 3_600,
                    "week" => 7 * 86_400,
                    "month" => 30 * 86_400,
                    "5h" => 5 * 3_600,
                    _ => 86_400,
                };
                (now / secs).to_string()
            }
        };
        let prev = state
            .get(&key)
            .filter(|(b, _)| *b == bucket)
            .map(|(_, t)| t.as_str())
            .unwrap_or("ok");
        if tier_rank(&a.tier) > tier_rank(prev) {
            escalated.push(a.clone());
        }
        fresh.insert(key, (bucket, a.tier.clone()));
    }
    let json = serde_json::to_string(&fresh).map_err(|e| e.to_string())?;
    let _ = db::set_setting(conn, USAGE_ALERT_STATE_KEY, &json);

    Ok((current, escalated))
}

/// Timer-free core of [`check_usage_limits`], callable from the backend
/// scheduler. Returns the CURRENT alerts; emits `usage:limit-alert` only for
/// tier escalations.
pub async fn run_usage_limit_checks(
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
) -> Vec<UsageLimitAlert> {
    let computed = {
        let conn = db.lock();
        compute_alerts(&conn, db::now_ts())
    };
    let Ok((current, escalated)) = computed else {
        return Vec::new();
    };
    for a in &escalated {
        let _ = app.emit("usage:limit-alert", a);
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        conn
    }

    fn add_chat_spend(conn: &Connection, now: i64, cost: f64) {
        conn.execute(
            "INSERT INTO chat_sessions (id, provider, model, created_at, last_active_at) \
             VALUES ('c1', 'commandcode', 'm', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages (chat_session_id, role, content, created_at, provider, \
             input_tokens, output_tokens, cost_usd) VALUES ('c1', 'assistant', 'x', ?1, 'commandcode', 1, 1, ?2)",
            rusqlite::params![now, cost],
        )
        .unwrap();
    }

    #[test]
    fn cap_state_computes_pct_and_tiers() {
        let mut windows = db::MeterWindows::default();
        windows.last_day.cost_usd = 0.86;
        windows.last_day.requests = 86;
        let cfg = UsageLimitConfig {
            target: "commandcode".into(),
            window: "day".into(),
            cap_usd: Some(1.0),
            cap_tokens: None,
            cap_requests: None,
            threshold_pct: 80.0,
        };
        let st = cap_state(&cfg, &windows);
        assert!((st.used_pct - 86.0).abs() < 0.01);
        assert_eq!(st.tier, "warn");

        windows.last_day.cost_usd = 1.5;
        let st = cap_state(&cfg, &windows);
        assert_eq!(st.tier, "crit");

        windows.last_day.cost_usd = 0.1;
        assert_eq!(cap_state(&cfg, &windows).tier, "ok");
    }

    #[test]
    fn local_models_are_excluded_from_meters_and_alerts() {
        let conn = test_conn();
        let now = 1_800_000_000;
        // One commandcode turn and one local-model turn.
        add_chat_spend(&conn, now - 60, 0.9);
        conn.execute(
            "INSERT INTO chat_sessions (id, provider, model, created_at, last_active_at) \
             VALUES ('c2', 'local_gguf', 'm', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages (chat_session_id, role, content, created_at, provider, \
             input_tokens, output_tokens, cost_usd) VALUES ('c2', 'assistant', 'x', ?1, 'local_gguf', 1, 1, 0.01)",
            rusqlite::params![now - 60],
        )
        .unwrap();
        // A cap configured on the local target must not resurrect the row.
        save_config(
            &conn,
            &[UsageLimitConfig {
                target: "chat:local_gguf".into(),
                window: "day".into(),
                cap_usd: Some(0.001),
                cap_tokens: None,
                cap_requests: None,
                threshold_pct: 80.0,
            }],
        )
        .unwrap();

        let meters = build_meters(&conn, now).unwrap();
        assert!(
            meters.iter().all(|m| m.target != "chat:local_gguf"),
            "local models have no limit to meter: {meters:#?}"
        );
        assert!(meters.iter().any(|m| m.target == "commandcode"));

        let (current, _) = compute_alerts(&conn, now).unwrap();
        assert!(current.iter().all(|a| a.target != "chat:local_gguf"));
    }

    #[test]
    fn set_and_clear_round_trip() {
        let conn = test_conn();
        let mut config = load_config(&conn);
        config.push(UsageLimitConfig {
            target: "commandcode".into(),
            window: "day".into(),
            cap_usd: Some(1.0),
            cap_tokens: None,
            cap_requests: None,
            threshold_pct: 80.0,
        });
        save_config(&conn, &config).unwrap();
        assert_eq!(load_config(&conn).len(), 1);
        let mut again = load_config(&conn);
        again.retain(|c| c.target != "commandcode");
        save_config(&conn, &again).unwrap();
        assert!(load_config(&conn).is_empty());
    }

    #[test]
    fn alerts_dedupe_per_tier_per_window() {
        let conn = test_conn();
        let now = 1_800_000_000;
        add_chat_spend(&conn, now - 60, 0.9);
        let cfg = vec![UsageLimitConfig {
            target: "commandcode".into(),
            window: "day".into(),
            cap_usd: Some(1.0),
            cap_tokens: None,
            cap_requests: None,
            threshold_pct: 80.0,
        }];
        save_config(&conn, &cfg).unwrap();

        let (current, escalated) = compute_alerts(&conn, now).unwrap();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].tier, "warn");
        assert_eq!(escalated.len(), 1, "first crossing notifies");

        // Same tier again in the same window: current still lists it, but no
        // new notification.
        let (current, escalated) = compute_alerts(&conn, now + 60).unwrap();
        assert_eq!(current.len(), 1);
        assert!(escalated.is_empty(), "no duplicate warn");

        // Crossing to crit DOES notify.
        conn.execute(
            "INSERT INTO chat_messages (chat_session_id, role, content, created_at, provider, \
             input_tokens, output_tokens, cost_usd) VALUES ('c1', 'assistant', 'x', ?1, 'commandcode', 1, 1, 0.5)",
            rusqlite::params![now + 61],
        )
        .unwrap();
        let (current, escalated) = compute_alerts(&conn, now + 120).unwrap();
        assert_eq!(current[0].tier, "crit");
        assert_eq!(escalated.len(), 1, "warn -> crit escalates");
    }

    #[test]
    fn reported_window_warns_at_eighty_percent() {
        let w = RateWindow {
            target: "claude_code".into(),
            window: "5h".into(),
            label: "5-hour window".into(),
            source: "claude_code".into(),
            used_pct: Some(85.0),
            used: None,
            limit: None,
            remaining: None,
            unit: "percent".into(),
            resets_at: Some(1_800_003_600),
            status: None,
            observed_at: 0,
        };
        let a = reported_alert(&w, "Claude Code").unwrap();
        assert_eq!(a.tier, "warn");

        let mut crit = w.clone();
        crit.used_pct = Some(101.0);
        crit.status = Some("exceeded".into());
        assert_eq!(reported_alert(&crit, "Claude Code").unwrap().tier, "crit");

        let mut ok = w;
        ok.used_pct = Some(42.0);
        assert!(reported_alert(&ok, "Claude Code").is_none());
    }

    /// The notch prints cap messages verbatim — raw token counts (410000)
    /// read as noise there, so the detail line shortens them.
    #[test]
    fn token_cap_detail_is_shortened() {
        assert_eq!(short_tokens(410_000), "410K");
        assert_eq!(short_tokens(1_250_000), "1.2M");
        assert_eq!(short_tokens(2_000_000), "2M");
        assert_eq!(short_tokens(999), "999");
        assert_eq!(short_tokens(0), "0");

        let config = UsageLimitConfig {
            target: "kimi_code".into(),
            window: "week".into(),
            cap_usd: None,
            cap_tokens: Some(500_000),
            cap_requests: None,
            threshold_pct: 80.0,
        };
        let windows = db::MeterWindows {
            last_week: db::UsageTotals { input_tokens: 410_000, ..Default::default() },
            ..Default::default()
        };
        let alert = cap_alert(&config, "Kimi Code", &windows).unwrap();
        assert_eq!(alert.tier, "warn");
        assert_eq!(alert.message, "Kimi Code at 82% of its weekly cap (410K / 500K tokens)");
    }
}
