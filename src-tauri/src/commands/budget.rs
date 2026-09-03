//! Budget / spend alerts (roadmap #10).
//!
//! A per-project monthly budget, configured in `app_settings` (`budget.config`,
//! a JSON array of [`BudgetConfig`]). On each check, the current calendar
//! month's spend per project (from the same pricing universe as the cost
//! dashboard — `cost_events` + assistant `chat_messages`) is compared against
//! each configured budget. Passing the threshold emits `budget:alert` to the
//! frontend (in-app toast) and pushes a `BudgetAlert` notice to connected
//! mobile devices.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::db;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// App-settings key holding the JSON `Vec<BudgetConfig>`.
const BUDGET_CONFIG_KEY: &str = "budget.config";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetConfig {
    pub project_id: String,
    /// Monthly spend cap in USD. Non-positive means "no budget" (skip).
    pub monthly_usd: f64,
    /// 0..100 — the percent of the budget at which to alert (default 100).
    #[serde(default = "default_threshold_pct")]
    pub threshold_pct: f64,
}

fn default_threshold_pct() -> f64 {
    100.0
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetAlertPayload {
    pub project_id: String,
    pub project_name: String,
    pub monthly_usd: f64,
    pub spent_usd: f64,
    /// Percent of the budget consumed (0..=any).
    pub used_pct: f64,
}

fn load_config(conn: &rusqlite::Connection) -> Vec<BudgetConfig> {
    match db::get_setting(conn, BUDGET_CONFIG_KEY) {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn save_config(conn: &rusqlite::Connection, config: &[BudgetConfig]) -> Result<(), String> {
    let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
    db::set_setting(conn, BUDGET_CONFIG_KEY, &json).map_err(|e| e.to_string())
}

// ---- Tauri commands ----

#[tauri::command]
pub fn list_budgets(db: State<'_, DbState>) -> CmdResult<Vec<BudgetConfig>> {
    let conn = db.0.lock();
    Ok(load_config(&conn))
}

/// Upsert a budget for a project. Pass `monthly_usd <= 0` to clear it.
#[tauri::command]
pub fn set_budget(
    db: State<'_, DbState>,
    project_id: String,
    monthly_usd: f64,
    threshold_pct: Option<f64>,
) -> CmdResult<BudgetConfig> {
    let conn = db.0.lock();
    let mut config = load_config(&conn);
    if monthly_usd <= 0.0 {
        config.retain(|b| b.project_id != project_id);
        save_config(&conn, &config)?;
        return Ok(BudgetConfig {
            project_id,
            monthly_usd: 0.0,
            threshold_pct: default_threshold_pct(),
        });
    }
    let pct = threshold_pct.unwrap_or_else(default_threshold_pct).clamp(0.0, 100.0);
    let cfg = BudgetConfig { project_id: project_id.clone(), monthly_usd, threshold_pct: pct };
    if let Some(existing) = config.iter_mut().find(|b| b.project_id == project_id) {
        *existing = cfg.clone();
    } else {
        config.push(cfg.clone());
    }
    save_config(&conn, &config)?;
    Ok(cfg)
}

#[tauri::command]
pub fn remove_budget(db: State<'_, DbState>, project_id: String) -> CmdResult<()> {
    let conn = db.0.lock();
    let mut config = load_config(&conn);
    config.retain(|b| b.project_id != project_id);
    save_config(&conn, &config)?;
    Ok(())
}

/// App-settings key holding the JSON `Vec<String>` of project ids hidden
/// from the Cost page's per-project list. Projects land there automatically
/// once they accrue spend; hiding is display-only — no usage rows are
/// deleted and any configured budget keeps alerting.
const HIDDEN_COST_PROJECTS_KEY: &str = "cost.hidden_project_ids";

fn load_hidden_projects(conn: &rusqlite::Connection) -> Vec<String> {
    match db::get_setting(conn, HIDDEN_COST_PROJECTS_KEY) {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn save_hidden_projects(conn: &rusqlite::Connection, ids: &[String]) -> Result<(), String> {
    let json = serde_json::to_string(ids).map_err(|e| e.to_string())?;
    db::set_setting(conn, HIDDEN_COST_PROJECTS_KEY, &json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_hidden_cost_projects(db: State<'_, DbState>) -> CmdResult<Vec<String>> {
    let conn = db.0.lock();
    Ok(load_hidden_projects(&conn))
}

/// Hide a project from the Cost page's per-project list. Idempotent.
#[tauri::command]
pub fn hide_cost_project(db: State<'_, DbState>, project_id: String) -> CmdResult<()> {
    let conn = db.0.lock();
    let mut ids = load_hidden_projects(&conn);
    if ids.iter().any(|id| id == &project_id) {
        return Ok(());
    }
    ids.push(project_id);
    save_hidden_projects(&conn, &ids)
}

#[tauri::command]
pub fn unhide_cost_project(db: State<'_, DbState>, project_id: String) -> CmdResult<()> {
    let conn = db.0.lock();
    let mut ids = load_hidden_projects(&conn);
    ids.retain(|id| id != &project_id);
    save_hidden_projects(&conn, &ids)
}

/// Compute the current calendar month's spend per project and, for each
/// configured budget that has crossed its threshold, emit `budget:alert` and
/// push a mobile notice. Called after cost events / on a timer. Returns the
/// alerts that fired.
#[tauri::command]
pub async fn check_budgets(app: AppHandle, db: State<'_, DbState>) -> CmdResult<Vec<BudgetAlertPayload>> {
    // Resolve to the start of the current month (approximate, via Unix epoch
    // day arithmetic). A robust window covering the month begins at the first
    // day of the current civil month.
    let now = db::now_ts();
    let since = {
        let days = now.div_euclid(86400);
        let (y, m) = civil_from_days(days);
        days_from_civil(y, m, 1) * 86400
    };
    // Guard against clock skew making `since` > `now` (future) — clamp to 31 days.
    let since = if since > now { now - 31 * 86400 } else { since };

    let config: Vec<BudgetConfig>;
    let rollups;
    {
        let conn = db.0.lock();
        config = load_config(&conn);
        // Re-pricing with a window covering the month; reuse the cached rollup.
        let days = ((now - since) / 86400).max(1) as u32;
        rollups = db::get_cost_rollups_v2(&conn, days).map_err(|e| e.to_string())?;
    }

    // Build project id → name for friendly alert text.
    let mut project_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    {
        let conn = db.0.lock();
        for p in db::list_projects(&conn).map_err(|e| e.to_string())? {
            project_names.insert(p.id.clone(), p.name);
        }
    }

    let mut alerts = Vec::new();
    for cfg in config.iter().filter(|b| b.monthly_usd > 0.0) {
        let spent = rollups
            .per_project
            .iter()
            .find(|p| p.project_id == cfg.project_id)
            .map(|p| p.total_cost_usd)
            .unwrap_or(0.0);
        let used_pct = if cfg.monthly_usd > 0.0 { spent / cfg.monthly_usd * 100.0 } else { 0.0 };
        if used_pct >= cfg.threshold_pct {
            let payload = BudgetAlertPayload {
                project_id: cfg.project_id.clone(),
                project_name: project_names.get(&cfg.project_id).cloned().unwrap_or_else(|| cfg.project_id.clone()),
                monthly_usd: cfg.monthly_usd,
                spent_usd: spent,
                used_pct,
            };
            alerts.push(payload.clone());
            let _ = app.emit("budget:alert", &payload);
            crate::mobile::relay::broadcast_budget_alert(
                &app,
                &payload.project_id,
                &payload.project_name,
                payload.monthly_usd,
                payload.spent_usd,
            );
        }
    }
    Ok(alerts)
}

/// Start-of-current-month Unix timestamp (approximate, using the local day
/// boundary; good enough for a budget threshold).
/// Convert days-since-epoch to (year 0-indexed, month 1-12).
fn civil_from_days(z: i64) -> (i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let _d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m)
}

/// Days from civil (proleptic) date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_start_returns_unix_epoch_for_known_dates() {
        // 2026-08-14 (approx). The month-start must be <= now and within 31 days.
        let ts: i64 = 1786730171;
        let days = ts.div_euclid(86400);
        let (y, m) = civil_from_days(days);
        let start = days_from_civil(y, m, 1) * 86400;
        assert!(start <= ts);
        assert!(ts - start < 31 * 86400);
        // The start is a day boundary (multiple of 86400).
        assert_eq!(start % 86400, 0);
    }

    #[test]
    fn civil_roundtrip() {
        // 1970-01-01 → epoch day 0 → year 1970, month 1.
        let (y, m) = civil_from_days(0);
        assert_eq!(y, 1970);
        assert_eq!(m, 1);
        // 2026-01-01 is some positive day count; days_from_civil should return
        // the same ts we feed civil_from_days.
        let days = days_from_civil(2026, 1, 1);
        let (yy, mm) = civil_from_days(days);
        assert_eq!(yy, 2026);
        assert_eq!(mm, 1);
    }

    #[test]
    fn hidden_projects_round_trip_and_dedupe() {
        let conn = crate::db::mem();
        assert!(load_hidden_projects(&conn).is_empty());
        save_hidden_projects(&conn, &["p1".into(), "p2".into()]).unwrap();
        assert_eq!(load_hidden_projects(&conn), vec!["p1".to_string(), "p2".to_string()]);
        // A stale hide (e.g. double-click) must not duplicate the id.
        let mut ids = load_hidden_projects(&conn);
        if !ids.iter().any(|id| id == "p1") {
            ids.push("p1".into());
            save_hidden_projects(&conn, &ids).unwrap();
        }
        assert_eq!(load_hidden_projects(&conn).len(), 2);
        let mut ids = load_hidden_projects(&conn);
        ids.retain(|id| id != "p1");
        save_hidden_projects(&conn, &ids).unwrap();
        assert_eq!(load_hidden_projects(&conn), vec!["p2".to_string()]);
    }
}
