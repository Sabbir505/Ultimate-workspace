//! Tauri commands for the Logs view and the gateway settings card.
//!
//! Thin by design: the store does the work, these only translate between the
//! frontend's camelCase wire shape and `rusqlite`. Every command takes the
//! lock once and drops it before returning — never held across an await.

use serde::Serialize;
use tauri::State;

use super::gateway;
use super::LogConfig;
use crate::db::llm_log as store;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// The filter the Logs view's filter bar sends.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFilterArgs {
    pub origin: Option<String>,
    pub target: Option<String>,
    pub search: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogConfigDto {
    pub enabled: bool,
    pub retention_days: i64,
    pub max_rows: i64,
    pub max_body_kb: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    /// 0 when the gateway failed to bind.
    pub port: u16,
    pub running: bool,
    pub require_auth: bool,
    /// Empty when auth is off, so the UI hides the copy button entirely
    /// rather than showing a token that isn't enforced.
    pub token: String,
    pub default_target: Option<String>,
    /// Distinct targets seen in the log, for the filter dropdown.
    pub known_targets: Vec<String>,
}

#[tauri::command(async)]
pub fn llm_log_list(db: State<'_, DbState>, filter: Option<LogFilterArgs>) -> CmdResult<Vec<store::LlmLogSummary>> {
    let f = filter.unwrap_or_default();
    let conn = db.0.lock();
    store::list(
        &conn,
        &store::LogFilter {
            origin: f.origin,
            target: f.target,
            search: f.search,
            limit: f.limit,
            before_created_at: None,
        },
    )
    .map_err(err)
}

#[tauri::command(async)]
pub fn llm_log_get(db: State<'_, DbState>, id: String) -> CmdResult<Option<store::LlmLogDetail>> {
    let conn = db.0.lock();
    store::get(&conn, &id).map_err(err)
}

#[tauri::command(async)]
pub fn llm_log_clear(db: State<'_, DbState>) -> CmdResult<usize> {
    let conn = db.0.lock();
    let n = store::clear(&conn).map_err(err)?;
    Ok(n)
}

#[tauri::command(async)]
pub fn llm_log_stats(db: State<'_, DbState>) -> CmdResult<store::LlmLogStats> {
    let conn = db.0.lock();
    store::stats(&conn).map_err(err)
}

#[tauri::command(async)]
pub fn llm_log_prune(db: State<'_, DbState>) -> CmdResult<usize> {
    let conn = db.0.lock();
    let cfg = LogConfig::load(&conn);
    Ok(super::prune(&conn, &cfg))
}

#[tauri::command(async)]
pub fn llm_log_config_get(db: State<'_, DbState>) -> CmdResult<LogConfigDto> {
    let conn = db.0.lock();
    let c = LogConfig::load(&conn);
    Ok(LogConfigDto {
        enabled: c.enabled,
        retention_days: c.retention_days,
        max_rows: c.max_rows,
        max_body_kb: c.max_body_kb,
    })
}

#[tauri::command(async)]
pub fn llm_log_config_set(
    db: State<'_, DbState>,
    enabled: Option<bool>,
    retention_days: Option<i64>,
    max_rows: Option<i64>,
    max_body_kb: Option<i64>,
) -> CmdResult<LogConfigDto> {
    {
        let conn = db.0.lock();
        if let Some(v) = enabled {
            crate::db::set_setting(&conn, super::ENABLED_KEY, if v { "1" } else { "0" }).map_err(err)?;
        }
        if let Some(v) = retention_days {
            crate::db::set_setting(&conn, super::RETENTION_DAYS_KEY, &v.clamp(1, 365).to_string()).map_err(err)?;
        }
        if let Some(v) = max_rows {
            crate::db::set_setting(&conn, super::MAX_ROWS_KEY, &v.clamp(100, 100_000).to_string()).map_err(err)?;
        }
        if let Some(v) = max_body_kb {
            crate::db::set_setting(&conn, super::MAX_BODY_KB_KEY, &v.clamp(4, 8192).to_string()).map_err(err)?;
        }
    }
    let conn = db.0.lock();
    let c = LogConfig::load(&conn);
    Ok(LogConfigDto {
        enabled: c.enabled,
        retention_days: c.retention_days,
        max_rows: c.max_rows,
        max_body_kb: c.max_body_kb,
    })
}

#[tauri::command(async)]
pub fn gateway_status(db: State<'_, DbState>) -> CmdResult<GatewayStatus> {
    let conn = db.0.lock();
    let require_auth = crate::db::get_setting(&conn, super::GATEWAY_REQUIRE_AUTH_KEY)
        .ok()
        .flatten()
        .map(|v| matches!(v.trim(), "1" | "true" | "yes"))
        .unwrap_or(true);
    let token = if require_auth {
        crate::db::get_setting(&conn, "gateway.token").ok().flatten().unwrap_or_default()
    } else {
        String::new()
    };
    let default_target = crate::db::get_setting(&conn, super::GATEWAY_DEFAULT_TARGET_KEY).ok().flatten();
    let known_targets = vec!["llamacpp".to_string(), "ollama".to_string(), "lmstudio".to_string()];
    let port = gateway::bound_port();
    Ok(GatewayStatus {
        port,
        running: port != 0,
        require_auth,
        token,
        default_target: default_target.filter(|t| !t.trim().is_empty()),
        known_targets,
    })
}

#[tauri::command(async)]
pub fn gateway_set_require_auth(db: State<'_, DbState>, require: bool) -> CmdResult<bool> {
    let conn = db.0.lock();
    crate::db::set_setting(&conn, super::GATEWAY_REQUIRE_AUTH_KEY, if require { "1" } else { "0" }).map_err(err)?;
    Ok(require)
}

#[tauri::command(async)]
pub fn gateway_set_default_target(db: State<'_, DbState>, target: Option<String>) -> CmdResult<()> {
    let conn = db.0.lock();
    let v = target.unwrap_or_default();
    crate::db::set_setting(&conn, super::GATEWAY_DEFAULT_TARGET_KEY, v.trim()).map_err(err)?;
    Ok(())
}

/// Register an arbitrary upstream so a runtime we don't know about can be
/// proxied without a rebuild: `{ "my-llama": "http://127.0.0.1:18080" }`.
#[tauri::command(async)]
pub fn gateway_set_targets(db: State<'_, DbState>, targets: serde_json::Value) -> CmdResult<()> {
    if !targets.is_object() {
        return Err("targets must be an object of name -> base url".into());
    }
    let conn = db.0.lock();
    crate::db::set_setting(&conn, "gateway.targets", &targets.to_string()).map_err(err)?;
    Ok(())
}

#[tauri::command(async)]
pub async fn gateway_probe(db: State<'_, DbState>, name: String) -> CmdResult<bool> {
    let target = {
        let conn = db.0.lock();
        gateway::resolve_target(&conn, name.trim())
    };
    match target {
        Some(t) => Ok(gateway::probe_target(&t.base_url).await),
        None => Ok(false),
    }
}
