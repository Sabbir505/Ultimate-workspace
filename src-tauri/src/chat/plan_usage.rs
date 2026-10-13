//! Provider- and CLI-reported usage windows ("plan usage").
//!
//! The usage meter needs two kinds of data that Relay cannot measure itself:
//! **(a) the limits** a provider/CLI enforces, and **(b) how much of them is
//! already spent**. This module is the store for both:
//!
//! - **Rate-limit headers** — Anthropic (`anthropic-ratelimit-*`) and OpenAI
//!   (`x-ratelimit-*`) responses carry requests/tokens remaining + reset.
//!   Captured at the streaming hot spots (`chat/streaming.rs`), throttled per
//!   provider so the hot path never pays a DB round-trip per request.
//! - **Claude Code `rate_limit` frames** — the CLI streams its own 5-hour /
//!   weekly window (`rate_limit_info`, utilization + `resetsAt`) on the
//!   headless stream; the reader records them here.
//! - **CommandCode plan API** — `/alpha/billing/credits` +
//!   `/alpha/billing/subscriptions` + `/alpha/usage/summary` on
//!   `api.commandcode.ai` (Bearer key from `~/.commandcode/auth.json` or
//!   `COMMAND_CODE_API_KEY`). Gives 5-hour and weekly windows (used/cap/reset),
//!   monthly credits remaining, and the billing-period spend. Cheap tiers
//!   without API access answer 404 — treated as "no data", never an error.
//! - **OpenCode Go** — `GET https://opencode.ai/zen/go/v1/usage` (Bearer key
//!   discovered from OpenCode's own auth file) returns rolling (5h) / weekly /
//!   monthly percentages + resets.
//! - **OpenRouter credits** — `/v1/auth/key` (remaining/usage) with a
//!   `/v1/credits` fallback, using the stored chat API key.
//!
//! Free tiers with no usage surface keep local usage only (the meters in
//! `db/usage.rs`); the shipped `usage_limit` error path ends turns when the
//! provider actually refuses. Nothing here is fabricated: a window exists only
//! if a source reported it.

use std::collections::HashMap;
use std::sync::OnceLock;

use parking_lot::Mutex;
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::db;

/// App-settings key holding the JSON [`UsageWindows`] blob.
pub const WINDOWS_KEY: &str = "usage.windows.v1";
/// Windows older than this are pruned on every save.
const WINDOW_TTL_SECS: i64 = 7 * 86400;
/// Max windows kept per (target, source) — newest first.
const MAX_WINDOWS_PER_SOURCE: usize = 12;
/// Header capture is throttled: these values change at most once a minute and
/// the streaming path must not take the DB lock per request.
const HEADER_THROTTLE_SECS: i64 = 45;
/// Plan fetches are throttled the same way (refresh button bypasses).
const FETCH_THROTTLE_SECS: i64 = 600;

const CC_BASE: &str = "https://api.commandcode.ai";
const OPENCODE_GO_USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
const OPENROUTER_DEFAULT_BASE: &str = "https://openrouter.ai/api";

/// One window of a provider/CLI-reported limit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateWindow {
    /// Rollup identity: `chat:<provider>` for API providers, bare harness id
    /// for CLIs (`claude_code`), `commandcode`, `opencode`, `opencode_go`.
    pub target: String,
    /// Machine key: `"5h" | "week" | "month" | "requests" | "tokens" | "credits"`.
    pub window: String,
    /// Human label for the UI ("5-hour window", …).
    pub label: String,
    /// Reporting source: `headers` | `claude_code` | `commandcode` |
    /// `opencode_go` | `openrouter`.
    pub source: String,
    /// Percent consumed, 0..=100+ (raw — >100 means over the limit).
    pub used_pct: Option<f64>,
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub remaining: Option<f64>,
    /// `usd` | `requests` | `tokens` | `percent`.
    pub unit: String,
    /// Epoch seconds.
    pub resets_at: Option<i64>,
    /// Provider status text; `exceeded` when the source flags it.
    pub status: Option<String>,
    pub observed_at: i64,
}

/// Account/plan-level numbers a source reported (CommandCode subscription,
/// OpenRouter credits, …).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanSnapshot {
    pub target: String,
    pub plan_name: Option<String>,
    pub plan_id: Option<String>,
    pub status: Option<String>,
    pub period_start: Option<i64>,
    pub period_end: Option<i64>,
    pub credits_remaining: Option<f64>,
    pub credits_total: Option<f64>,
    /// `usd` (CommandCode credits / OpenRouter) — kept for future units.
    pub credits_unit: String,
    /// Period totals the source itself reported (CommandCode's usage summary):
    /// ACCOUNT-WIDE tokens / runs / $ for the billing period — the numbers the
    /// vendor's own dashboard shows, which Relay's local measurement cannot
    /// match (other machines and the Studio UI count too).
    #[serde(default)]
    pub tokens_total: Option<i64>,
    #[serde(default)]
    pub requests_total: Option<i64>,
    #[serde(default)]
    pub cost_total_usd: Option<f64>,
    pub source: String,
    pub observed_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindows {
    pub windows: Vec<RateWindow>,
    pub plans: Vec<PlanSnapshot>,
}

/// What a refresh attempt did — surfaced by the panel's Refresh button.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshReport {
    pub updated: Vec<String>,
    pub errors: Vec<String>,
}

// ---------------------------------------------------------------- time utils

fn now_secs() -> i64 {
    db::now_ts()
}

/// Accepts epoch seconds, epoch millis (numbers > 1e11) and RFC3339 strings.
fn parse_ts(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    if let Some(n) = v.as_f64() {
        let n = n as i64;
        return Some(if n > 100_000_000_000 { n / 1000 } else { n });
    }
    let s = v.as_str()?;
    parse_rfc3339_secs(s)
}

fn parse_rfc3339_secs(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s.trim())
        .ok()
        .map(|dt| dt.timestamp())
}

/// OpenAI resets come as durations ("1s", "6m0s", "1h2m3s", "12ms", "500").
/// Units may be multi-char (`ms`, `us`), so the scan takes the run of
/// non-digit characters after each number as one unit token.
fn parse_duration_secs(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(v) = s.parse::<f64>() {
        return Some(v as i64);
    }
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut total = 0f64;
    let mut any = false;
    while i < bytes.len() {
        let start = i;
        while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
            i += 1;
        }
        if start == i {
            return None; // a unit with no number
        }
        let n: f64 = s[start..i].parse().ok()?;
        let ustart = i;
        while i < bytes.len() && !bytes[i].is_ascii_digit() && bytes[i] != b'.' {
            i += 1;
        }
        total += match &s[ustart..i] {
            "ms" => n / 1000.0,
            "us" | "µs" => n / 1_000_000.0,
            "s" | "" => n,
            "m" => n * 60.0,
            "h" => n * 3600.0,
            "d" => n * 86_400.0,
            _ => return None,
        };
        any = true;
    }
    any.then(|| total as i64)
}

fn f64_at(v: &Value, keys: &[&str]) -> Option<f64> {
    for k in keys {
        if let Some(n) = v.get(*k).and_then(|x| x.as_f64()) {
            return Some(n);
        }
    }
    None
}

fn str_at(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Depth-first search for the first present field among `keys`, at ANY nesting
/// level (capped). The credits payload's shape has drifted before, and a
/// silently missing monthly row is worse than a lenient search.
fn find_value_nested<'a>(v: &'a Value, keys: &[&str], depth: usize) -> Option<&'a Value> {
    if depth > 4 {
        return None;
    }
    for k in keys {
        if let Some(hit) = v.get(*k) {
            return Some(hit);
        }
    }
    match v {
        Value::Object(map) => map
            .values()
            .find_map(|x| find_value_nested(x, keys, depth + 1)),
        Value::Array(items) => items
            .iter()
            .find_map(|x| find_value_nested(x, keys, depth + 1)),
        _ => None,
    }
}

fn nested_f64(v: &Value, keys: &[&str]) -> Option<f64> {
    find_value_nested(v, keys, 0).and_then(|x| x.as_f64())
}

fn nested_i64(v: &Value, keys: &[&str]) -> Option<i64> {
    find_value_nested(v, keys, 0).and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
}

// ------------------------------------------------------------ header capture

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn header_num(headers: &HeaderMap, name: &str) -> Option<f64> {
    header_str(headers, name).and_then(|s| s.trim().parse::<f64>().ok())
}

/// Pure: parse both provider header families into windows. Extracted so tests
/// can exercise it without an AppHandle.
fn windows_from_headers(provider: &str, headers: &HeaderMap, now: i64) -> Vec<RateWindow> {
    let target = format!("chat:{provider}");
    let mut out = Vec::new();

    // Anthropic: <family>-limit / -remaining / -reset (RFC3339).
    for (key, label, unit) in [
        ("requests", "Request rate limit", "requests"),
        ("tokens", "Token rate limit", "tokens"),
    ] {
        let limit = header_num(headers, &format!("anthropic-ratelimit-{key}-limit"));
        let remaining = header_num(headers, &format!("anthropic-ratelimit-{key}-remaining"));
        let resets_at = header_str(headers, &format!("anthropic-ratelimit-{key}-reset"))
            .and_then(parse_rfc3339_secs);
        if limit.is_none() && remaining.is_none() {
            continue;
        }
        out.push(make_window(
            &target,
            key,
            label,
            "headers",
            limit.zip(remaining).map(|(l, r)| l - r),
            limit,
            remaining,
            unit.to_string(),
            resets_at,
            None,
            now,
        ));
    }

    // OpenAI: x-ratelimit-{limit,remaining,reset}-{requests,tokens}; resets are
    // duration strings measured from now.
    for (key, label, unit) in [
        ("requests", "Request rate limit", "requests"),
        ("tokens", "Token rate limit", "tokens"),
    ] {
        let limit = header_num(headers, &format!("x-ratelimit-limit-{key}"))
            .or_else(|| header_num(headers, &format!("x-ratelimit-{key}-limit")));
        let remaining = header_num(headers, &format!("x-ratelimit-remaining-{key}"))
            .or_else(|| header_num(headers, &format!("x-ratelimit-{key}-remaining")));
        let resets_at = header_str(headers, &format!("x-ratelimit-reset-{key}"))
            .and_then(parse_duration_secs)
            .map(|d| now + d);
        if limit.is_none() && remaining.is_none() {
            continue;
        }
        out.push(make_window(
            &target,
            key,
            label,
            "headers",
            limit.zip(remaining).map(|(l, r)| l - r),
            limit,
            remaining,
            unit.to_string(),
            resets_at,
            None,
            now,
        ));
    }

    out
}

#[allow(clippy::too_many_arguments)]
fn make_window(
    target: &str,
    window: &str,
    label: &str,
    source: &str,
    used: Option<f64>,
    limit: Option<f64>,
    remaining: Option<f64>,
    unit: String,
    resets_at: Option<i64>,
    status: Option<String>,
    now: i64,
) -> RateWindow {
    let remaining = remaining.or_else(|| match (limit, used) {
        (Some(l), Some(u)) => Some(l - u),
        _ => None,
    });
    let used_pct = match (used, limit) {
        (Some(u), Some(l)) if l > 0.0 => Some(u / l * 100.0),
        _ => None,
    };
    RateWindow {
        target: target.to_string(),
        window: window.to_string(),
        label: label.to_string(),
        source: source.to_string(),
        used_pct,
        used,
        limit,
        remaining,
        unit,
        resets_at,
        status,
        observed_at: now,
    }
}

/// Parse a `{used, cap, remaining, percentage, resetAt, exceeded}`-shaped
/// window object (CommandCode / OpenCode Go window bodies).
fn window_from_parts(
    target: &str,
    window: &str,
    label: &str,
    source: &str,
    v: &Value,
    unit: &str,
    now: i64,
) -> Option<RateWindow> {
    let used = f64_at(v, &["used"]);
    let limit = f64_at(v, &["cap", "limit"]);
    let remaining = f64_at(v, &["remaining"]);
    let mut used_pct = f64_at(v, &["percentage", "percent", "used_pct", "usedPct", "used_percentage"]);
    if used_pct.is_none() {
        if let (Some(u), Some(l)) = (used, limit) {
            if l > 0.0 {
                used_pct = Some(u / l * 100.0);
            }
        }
    }
    let resets_at = parse_ts(v.get("resetAt"))
        .or_else(|| parse_ts(v.get("resetsAt")))
        .or_else(|| parse_ts(v.get("reset_at")))
        .or_else(|| {
            v.get("reset_in_seconds")
                .and_then(|x| x.as_f64())
                .map(|s| now + s as i64)
        });
    let mut status = str_at(v, &["status"]);
    if v.get("exceeded").and_then(|x| x.as_bool()).unwrap_or(false) {
        status = Some("exceeded".to_string());
    }
    if used.is_none() && limit.is_none() && remaining.is_none() && used_pct.is_none() {
        return None;
    }
    let mut rw = make_window(
        target,
        window,
        label,
        source,
        used,
        limit,
        remaining,
        unit.to_string(),
        resets_at,
        status,
        now,
    );
    // A percentage the source reported wins over the derived one (it can
    // exceed 100 when the provider flags an over-limit window).
    if let Some(p) = used_pct {
        rw.used_pct = Some(p);
    }
    Some(rw)
}

/// Record Anthropic/OpenAI rate-limit headers for a provider. Throttled per
/// provider so the streaming hot path takes no DB lock more than once a
/// minute-ish; silently no-ops when the headers carry nothing.
pub fn record_headers<R: tauri::Runtime>(app: &AppHandle<R>, provider: &str, headers: &HeaderMap) {
    if !throttle_ok(&format!("hdr:{provider}"), HEADER_THROTTLE_SECS) {
        return;
    }
    let windows = windows_from_headers(provider, headers, now_secs());
    if windows.is_empty() {
        return;
    }
    with_db(app, |conn| upsert(conn, windows, Vec::new()));
}

// ------------------------------------------------------ Claude Code windows

/// Pure: parse one Claude Code `rate_limit` frame into a window. The frame has
/// evolved upstream (status/resetsAt only at first; utilization added later),
/// so every field is read liberally and an unrecognized shape returns `None`.
fn window_from_claude_frame(v: &Value, now: i64) -> Option<RateWindow> {
    let info = v.get("rate_limit_info").unwrap_or(v);
    let ty = str_at(info, &["rateLimitType", "type", "name", "window"]);
    let window = match ty.as_deref() {
        Some(t) if t.contains("five") || t.contains("5h") || t.contains("5_h") => "5h",
        Some(t) if t.contains("seven") || t.contains("week") || t.contains("7d") => "week",
        _ => "window",
    };
    let label = match window {
        "5h" => "5-hour window",
        "week" => "Weekly window",
        _ => "Rate-limit window",
    };
    // `utilization` is 0..1; percentage-style fields are already 0..100.
    let mut used_pct = f64_at(info, &["used_percentage", "usedPct", "percent", "percentage"]);
    if used_pct.is_none() {
        if let Some(u) = f64_at(info, &["utilization"]) {
            used_pct = Some(if u <= 1.5 { u * 100.0 } else { u });
        }
    }
    let resets_at = parse_ts(info.get("resetsAt"))
        .or_else(|| parse_ts(info.get("resets_at")))
        .or_else(|| parse_ts(info.get("resetAt")));
    let status = str_at(info, &["status"]);
    if ty.is_none() && used_pct.is_none() && resets_at.is_none() && status.is_none() {
        warn_unknown_claude_frame(v);
        return None;
    }
    Some(RateWindow {
        target: "claude_code".to_string(),
        window: window.to_string(),
        label: label.to_string(),
        source: "claude_code".to_string(),
        used_pct,
        used: None,
        limit: None,
        remaining: None,
        unit: "percent".to_string(),
        resets_at,
        status,
        observed_at: now,
    })
}

/// One dev-log line per process for a frame shape we don't understand — the
/// upstream schema can change, and that must never spam the log per turn.
fn warn_unknown_claude_frame(v: &Value) {
    static WARNED: OnceLock<()> = OnceLock::new();
    let _ = WARNED.get_or_init(|| {
        crate::relay_eprintln!(
            "[usage] unrecognized Claude Code rate_limit frame (no window/utilization/resets fields): {}",
            crate::util::truncate_chars(&v.to_string(), 400)
        );
    });
}

pub fn record_claude_rate_limit<R: tauri::Runtime>(app: &AppHandle<R>, v: &Value) {
    if let Some(rw) = window_from_claude_frame(v, now_secs()) {
        with_db(app, |conn| upsert(conn, vec![rw], Vec::new()));
    }
}

// ------------------------------------------------------------------- storage

pub fn load(conn: &rusqlite::Connection) -> UsageWindows {
    match db::get_setting(conn, WINDOWS_KEY) {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => UsageWindows::default(),
    }
}

fn save(conn: &rusqlite::Connection, state: &UsageWindows) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|e| e.to_string())?;
    db::set_setting(conn, WINDOWS_KEY, &json).map_err(|e| e.to_string())
}

/// Replace same-key rows, prune stale ones, persist. Windows key on
/// (target, window, source); plans on (target, source).
pub fn upsert(conn: &rusqlite::Connection, windows: Vec<RateWindow>, plans: Vec<PlanSnapshot>) {
    let mut state = load(conn);
    for w in windows {
        state
            .windows
            .retain(|e| !(e.target == w.target && e.window == w.window && e.source == w.source));
        state.windows.push(w);
    }
    for p in plans {
        state
            .plans
            .retain(|e| !(e.target == p.target && e.source == p.source));
        state.plans.push(p);
    }
    let now = now_secs();
    state.windows.retain(|w| now - w.observed_at <= WINDOW_TTL_SECS);
    state.plans.retain(|p| now - p.observed_at <= WINDOW_TTL_SECS);
    // Cap windows per source, newest first.
    let mut counts: HashMap<(String, String), usize> = HashMap::new();
    state.windows.sort_by(|a, b| b.observed_at.cmp(&a.observed_at));
    state.windows.retain(|w| {
        let key = (w.target.clone(), w.source.clone());
        let n = counts.entry(key).or_insert(0);
        *n += 1;
        *n <= MAX_WINDOWS_PER_SOURCE
    });
    let _ = save(conn, &state);
}

pub fn read(conn: &rusqlite::Connection) -> UsageWindows {
    load(conn)
}

fn with_db<R: tauri::Runtime>(app: &AppHandle<R>, f: impl FnOnce(&rusqlite::Connection)) {
    let Some(state) = app.try_state::<crate::DbState>() else {
        return;
    };
    let conn = state.0.lock();
    f(&conn);
}

/// In-process throttle: true (and records `now`) when `key` has not been seen
/// within `min_secs`. `min_secs <= 0` always passes.
fn throttle_ok(key: &str, min_secs: i64) -> bool {
    if min_secs <= 0 {
        return true;
    }
    static LAST: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    let m = LAST.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = m.lock();
    let now = now_secs();
    match guard.get(key) {
        Some(&last) if now - last < min_secs => false,
        _ => {
            guard.insert(key.to_string(), now);
            true
        }
    }
}

// ---------------------------------------------------------------- credentials

fn env_first(names: &[&str]) -> Option<String> {
    for n in names {
        if let Ok(v) = std::env::var(n) {
            if !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

fn read_json_file(path: &std::path::Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Recursively find the first string value starting with `prefix` (depth cap).
fn scan_string_with_prefix(v: &Value, prefix: &str, depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }
    match v {
        Value::String(s) if s.starts_with(prefix) => Some(s.clone()),
        Value::Object(map) => map
            .values()
            .find_map(|x| scan_string_with_prefix(x, prefix, depth + 1)),
        Value::Array(items) => items
            .iter()
            .find_map(|x| scan_string_with_prefix(x, prefix, depth + 1)),
        _ => None,
    }
}

/// CommandCode provider key: explicit env vars first, then any
/// `*commandcode*` env var, then the CLI's own login state
/// (`~/.commandcode/auth.json` — `{ "apiKey": "user_…" }`).
fn commandcode_api_key() -> Option<String> {
    if let Some(v) = env_first(&[
        "COMMAND_CODE_API_KEY",
        "COMMANDCODE_API_KEY",
        "CMD_API_KEY",
    ]) {
        return Some(v);
    }
    for (k, v) in std::env::vars() {
        if k.to_lowercase().contains("commandcode") && !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    let home = dirs::home_dir()?;
    let doc = read_json_file(&home.join(".commandcode").join("auth.json"))?;
    doc.get("apiKey")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// OpenCode key: env first, then OpenCode's own auth store. The key is an
/// `sk-…` provider key used by both `opencode serve` and the Go plan endpoint.
fn opencode_api_key() -> Option<String> {
    if let Some(v) = env_first(&["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"]) {
        return Some(v);
    }
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/share/opencode/auth.json"));
        candidates.push(home.join(".config/opencode/auth.json"));
    }
    if let Some(data) = dirs::data_dir() {
        candidates.push(data.join("opencode").join("auth.json"));
    }
    for p in candidates {
        if let Some(doc) = read_json_file(&p) {
            if let Some(key) = scan_string_with_prefix(&doc, "sk-", 0) {
                return Some(key);
            }
        }
    }
    None
}

// --------------------------------------------------------------- plan fetches

struct HttpErr {
    status: Option<u16>,
    msg: String,
}

impl HttpErr {
    /// 401/403/404 mean "this plan has no API access / bad key" — callers
    /// treat those as absence of data, not as an error to surface.
    fn no_access(&self) -> bool {
        matches!(self.status, Some(401) | Some(403) | Some(404))
    }
}

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    bearer: Option<&str>,
) -> Result<Value, HttpErr> {
    let mut req = client.get(url);
    if let Some(k) = bearer {
        req = req.header("Authorization", format!("Bearer {k}"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| HttpErr {
            status: None,
            msg: format!("{e}"),
        })?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(HttpErr {
            status: Some(status.as_u16()),
            msg: crate::util::truncate_chars(&text, 200),
        });
    }
    serde_json::from_str(&text).map_err(|e| HttpErr {
        status: None,
        msg: format!("non-JSON response: {e}"),
    })
}

/// CommandCode period summary (`/alpha/usage/summary`). `since` is the RAW
/// RFC3339 `currentPeriodStart` string the subscriptions call returned — a
/// parsed epoch is rejected, and a bare `+` in the offset would read as a
/// space in a query string (hence the encode). A rejected `since` retries
/// un-scoped before failing.
async fn fetch_cc_summary(
    client: &reqwest::Client,
    key: &str,
    since: Option<&str>,
) -> Result<Value, String> {
    if let Some(s) = since.filter(|s| !s.trim().is_empty()) {
        let url = format!("{CC_BASE}/alpha/usage/summary?since={}", s.replace('+', "%2B"));
        match get_json(client, &url, Some(key)).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                crate::relay_eprintln!(
                    "[usage] CommandCode summary rejected since={s} ({}); retrying unscoped",
                    e.msg
                );
            }
        }
    }
    get_json(client, &format!("{CC_BASE}/alpha/usage/summary"), Some(key))
        .await
        .map_err(|e| e.msg)
}

/// Pure: the monthly credits window + credit totals from the credits payload
/// and the period summary. Extracted so the shape tolerance (nested
/// `credits.credits` vs a flattened envelope; summary present or not) is
/// testable without a network call — a silently missing monthly row is the
/// exact failure this guards.
fn cc_monthly(
    credits: &Value,
    summary: Option<&Value>,
    period_end: Option<i64>,
    now: i64,
) -> (Option<RateWindow>, Option<f64>, Option<f64>) {
    let remaining: Option<f64> = {
        let parts = [
            nested_f64(credits, &["monthlyCredits"]),
            nested_f64(credits, &["purchasedCredits"]),
            nested_f64(credits, &["freeCredits"]),
        ];
        if parts.iter().all(|p| p.is_none()) {
            None
        } else {
            Some(parts.iter().flatten().sum())
        }
    };
    let spent = summary.and_then(|s| nested_f64(s, &["totalCost"]));
    let total = match (spent, remaining) {
        (Some(u), Some(r)) => Some(u + r),
        (None, Some(r)) => Some(r),
        _ => None,
    };
    let window = if remaining.is_some() || spent.is_some() {
        Some(make_window(
            "commandcode",
            "month",
            "Monthly credits",
            "commandcode",
            spent,
            match (spent, remaining) {
                (Some(u), Some(r)) => Some(u + r),
                _ => None,
            },
            remaining,
            "usd".to_string(),
            period_end,
            credits
                .get("credits")
                .and_then(|c| c.get("belowThreshold"))
                .or_else(|| credits.get("belowThreshold"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                .then(|| "below threshold".to_string()),
            now,
        ))
    } else {
        None
    };
    (window, remaining, total)
}

/// Pure: classify CommandCode `windowLimits` entries by NAME and parse each
/// into a window. The documented pair is `fiveHour`/`weekly`; the vendor's own
/// dashboard additionally shows a MONTHLY window, so month/30-day spellings are
/// matched liberally rather than against a fixed table.
fn windows_from_cc_limits(credits: &Value, now: i64) -> Vec<RateWindow> {
    let Some(wl) = credits.get("windowLimits").and_then(|w| w.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (key_name, w) in wl {
        let k = key_name.to_lowercase();
        let (window, label) = if k.contains("five") || k.contains("5h") {
            ("5h", "5-hour window")
        } else if k.contains("week") || k.contains("7d") {
            ("week", "Weekly window")
        } else if k.contains("month") || k.contains("30") || k.contains("thirty") {
            ("month", "Monthly window")
        } else {
            continue;
        };
        if let Some(rw) = window_from_parts(
            "commandcode",
            window,
            label,
            "commandcode",
            w,
            "usd",
            now,
        ) {
            out.push(rw);
        }
    }
    out
}

/// Pure: period totals from the usage summary (account-wide).
fn cc_summary_totals(summary: Option<&Value>) -> (Option<i64>, Option<i64>, Option<f64>) {
    let Some(s) = summary else {
        return (None, None, None);
    };
    (
        nested_i64(s, &["totalTokens"]),
        nested_i64(s, &["totalCount"]),
        nested_f64(s, &["totalCost"]),
    )
}

/// CommandCode: 5h/weekly windows + monthly credits + billing period.
async fn fetch_commandcode(
    client: &reqwest::Client,
) -> Result<Option<(Vec<RateWindow>, PlanSnapshot)>, String> {
    let Some(key) = commandcode_api_key() else {
        return Ok(None);
    };
    let credits = match get_json(
        client,
        &format!("{CC_BASE}/alpha/billing/credits"),
        Some(&key),
    )
    .await
    {
        Ok(v) => v,
        Err(e) if e.no_access() => return Ok(None),
        Err(e) => return Err(e.msg),
    };
    let subs = get_json(
        client,
        &format!("{CC_BASE}/alpha/billing/subscriptions"),
        Some(&key),
    )
    .await
    .ok();
    let sub = subs.as_ref().and_then(|s| s.get("data"));
    let period_end = sub.and_then(|s| parse_ts(s.get("currentPeriodEnd")));
    let period_start = sub.and_then(|s| parse_ts(s.get("currentPeriodStart")));
    // The summary endpoint takes the RAW period-start STRING it returned back
    // as `since` — sending a parsed epoch is rejected, and while that failure
    // was silent the 5h/weekly windows still rendered, so the monthly window
    // simply never appeared. Pass the original string, fall back to the
    // un-scoped call, and log the failure so a shape change is diagnosable.
    let period_start_raw = sub
        .and_then(|s| s.get("currentPeriodStart"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let summary = match fetch_cc_summary(client, &key, period_start_raw.as_deref()).await {
        Ok(v) => Some(v),
        Err(e) => {
            crate::relay_eprintln!(
                "[usage] CommandCode usage/summary unavailable ({e}) — monthly credits show the \
                 remaining balance only"
            );
            None
        }
    };

    let now = now_secs();
    let mut windows = windows_from_cc_limits(&credits, now);
    // Monthly: prefer the API's own monthly window (the vendor dashboard
    // renders one); when it is absent, derive a used/limit pair from the
    // leftover credits + the period summary spend — no guessing.
    let has_month_window = windows.iter().any(|w| w.window == "month");
    let (monthly_window, remaining, credits_total) =
        cc_monthly(&credits, summary.as_ref(), period_end, now);
    if !has_month_window {
        if let Some(w) = monthly_window {
            windows.push(w);
        }
    }
    let (tokens_total, requests_total, cost_total_usd) = cc_summary_totals(summary.as_ref());

    let plan = PlanSnapshot {
        target: "commandcode".to_string(),
        plan_name: sub
            .and_then(|s| str_at(s, &["planName", "planId"]))
            .or_else(|| Some("CommandCode".to_string())),
        plan_id: sub.and_then(|s| str_at(s, &["planId"])),
        status: sub.and_then(|s| str_at(s, &["status"])),
        period_start,
        period_end,
        credits_remaining: remaining,
        credits_total,
        credits_unit: "usd".to_string(),
        tokens_total,
        requests_total,
        cost_total_usd,
        source: "commandcode".to_string(),
        observed_at: now,
    };
    Ok(Some((windows, plan)))
}

/// OpenCode Go (paid plan): rolling (5h) / weekly / monthly percentages.
async fn fetch_opencode_go(
    client: &reqwest::Client,
) -> Result<Option<(Vec<RateWindow>, PlanSnapshot)>, String> {
    let Some(key) = opencode_api_key() else {
        return Ok(None);
    };
    let body = match get_json(client, OPENCODE_GO_USAGE_URL, Some(&key)).await {
        Ok(v) => v,
        Err(e) if e.no_access() => return Ok(None),
        Err(e) => return Err(e.msg),
    };
    let base = body.get("windows").unwrap_or(&body);
    let now = now_secs();
    let mut windows = Vec::new();
    for (key_name, window, label) in [
        ("rolling", "5h", "Rolling 5-hour window"),
        ("weekly", "week", "Weekly window"),
        ("monthly", "month", "Monthly window"),
    ] {
        if let Some(w) = base.get(key_name) {
            if let Some(rw) =
                window_from_parts("opencode_go", window, label, "opencode_go", w, "percent", now)
            {
                windows.push(rw);
            }
        }
    }
    if windows.is_empty() {
        return Ok(None);
    }
    let plan = PlanSnapshot {
        target: "opencode_go".to_string(),
        plan_name: Some("OpenCode Go".to_string()),
        plan_id: None,
        status: None,
        period_start: None,
        period_end: None,
        credits_remaining: None,
        credits_total: None,
        credits_unit: "usd".to_string(),
        tokens_total: None,
        requests_total: None,
        cost_total_usd: None,
        source: "opencode_go".to_string(),
        observed_at: now,
    };
    Ok(Some((windows, plan)))
}

/// OpenRouter: account credits (used/remaining) from `/v1/auth/key`, with a
/// `/v1/credits` fallback.
async fn fetch_openrouter(
    client: &reqwest::Client,
    key: Option<String>,
    base: Option<String>,
) -> Result<Option<(Vec<RateWindow>, PlanSnapshot)>, String> {
    let Some(key) = key else {
        return Ok(None);
    };
    let base = base
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| OPENROUTER_DEFAULT_BASE.to_string());
    let base = base.trim_end_matches('/').to_string();
    let now = now_secs();
    let mut used = None;
    let mut limit = None;
    let mut remaining = None;
    let mut plan_name = "OpenRouter".to_string();

    match get_json(client, &format!("{base}/v1/auth/key"), Some(&key)).await {
        Ok(v) => {
            let d = v.get("data").unwrap_or(&v);
            used = f64_at(d, &["usage"]);
            limit = f64_at(d, &["limit"]);
            remaining = f64_at(d, &["limit_remaining"]);
            if d.get("is_free_tier").and_then(|x| x.as_bool()) == Some(true) {
                plan_name = "OpenRouter (free tier)".to_string();
            }
        }
        Err(e) if e.no_access() => return Ok(None),
        Err(_) => {}
    }
    if remaining.is_none() && limit.is_none() {
        if let Ok(v) = get_json(client, &format!("{base}/v1/credits"), Some(&key)).await {
            let d = v.get("data").unwrap_or(&v);
            let total = f64_at(d, &["total_credits"]);
            used = f64_at(d, &["total_usage"]);
            limit = total;
            remaining = match (total, used) {
                (Some(t), Some(u)) => Some(t - u),
                (Some(t), None) => Some(t),
                _ => None,
            };
        }
    }
    if remaining.is_none() && limit.is_none() && used.is_none() {
        return Ok(None);
    }
    let windows = vec![make_window(
        "chat:openrouter",
        "credits",
        "Account credits",
        "openrouter",
        used,
        limit,
        remaining,
        "usd".to_string(),
        None,
        None,
        now,
    )];
    let plan = PlanSnapshot {
        target: "chat:openrouter".to_string(),
        plan_name: Some(plan_name),
        plan_id: None,
        status: None,
        period_start: None,
        period_end: None,
        credits_remaining: remaining,
        credits_total: limit,
        credits_unit: "usd".to_string(),
        tokens_total: None,
        requests_total: None,
        cost_total_usd: None,
        source: "openrouter".to_string(),
        observed_at: now,
    };
    Ok(Some((windows, plan)))
}

/// Refresh every plan source (throttled unless `force`). Credentials are read
/// under one short DB lock before any await; fetches then run concurrently.
pub async fn refresh<R: tauri::Runtime>(app: &AppHandle<R>, force: bool) -> RefreshReport {
    let ttl = if force { 0 } else { FETCH_THROTTLE_SECS };
    let want_commandcode = throttle_ok("fetch:commandcode", ttl);
    let want_opencode = throttle_ok("fetch:opencode_go", ttl);
    let want_openrouter = throttle_ok("fetch:openrouter", ttl);
    if !want_commandcode && !want_opencode && !want_openrouter {
        return RefreshReport::default();
    }

    // Read the OpenRouter credentials under a scoped lock.
    let (or_key, or_base) = {
        let Some(state) = app.try_state::<crate::DbState>() else {
            return RefreshReport::default();
        };
        let conn = state.0.lock();
        (
            crate::secrets::get_chat_api_key(&conn, "openrouter"),
            db::get_setting(&conn, "chat.openrouter.base_url").unwrap_or(None),
        )
    };

    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return RefreshReport {
                updated: Vec::new(),
                errors: vec![format!("http client: {e}")],
            }
        }
    };

    let cc = async {
        if want_commandcode {
            Some(("commandcode", fetch_commandcode(&client).await))
        } else {
            None
        }
    };
    let oc = async {
        if want_opencode {
            Some(("opencode_go", fetch_opencode_go(&client).await))
        } else {
            None
        }
    };
    let orr = async {
        if want_openrouter {
            Some((
                "openrouter",
                fetch_openrouter(&client, or_key, or_base).await,
            ))
        } else {
            None
        }
    };
    let (cc, oc, orr) = tokio::join!(cc, oc, orr);

    let mut report = RefreshReport::default();
    let mut windows = Vec::new();
    let mut plans = Vec::new();
    for (name, res) in [cc, oc, orr].into_iter().flatten() {
        match res {
            Ok(Some((w, p))) => {
                windows.extend(w);
                plans.push(p);
                report.updated.push(name.to_string());
            }
            Ok(None) => {}
            Err(e) => report.errors.push(format!("{name}: {e}")),
        }
    }
    if !windows.is_empty() || !plans.is_empty() {
        with_db(app, |conn| upsert(conn, windows, plans));
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                reqwest::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                reqwest::header::HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn anthropic_headers_become_windows() {
        let h = headers(&[
            ("anthropic-ratelimit-requests-limit", "50"),
            ("anthropic-ratelimit-requests-remaining", "12"),
            ("anthropic-ratelimit-requests-reset", "2026-10-13T12:00:00Z"),
            ("anthropic-ratelimit-tokens-remaining", "90000"),
        ]);
        let w = windows_from_headers("anthropic", &h, 1_700_000_000);
        assert_eq!(w.len(), 2, "{w:#?}");
        let req = w.iter().find(|x| x.window == "requests").unwrap();
        assert_eq!(req.target, "chat:anthropic");
        assert_eq!(req.limit, Some(50.0));
        assert_eq!(req.remaining, Some(12.0));
        assert_eq!(req.used, Some(38.0));
        assert!((req.used_pct.unwrap() - 76.0).abs() < 0.01);
        assert_eq!(req.resets_at, Some(1_791_892_800)); // 2026-10-13T12:00:00Z
        let tok = w.iter().find(|x| x.window == "tokens").unwrap();
        assert_eq!(tok.remaining, Some(90_000.0));
    }

    #[test]
    fn openai_headers_parse_duration_resets() {
        let now = 1_700_000_000;
        let h = headers(&[
            ("x-ratelimit-limit-requests", "60"),
            ("x-ratelimit-remaining-requests", "59"),
            ("x-ratelimit-reset-requests", "6m0s"),
            ("x-ratelimit-limit-tokens", "150000"),
            ("x-ratelimit-remaining-tokens", "149000"),
            ("x-ratelimit-reset-tokens", "12s"),
        ]);
        let w = windows_from_headers("openai", &h, now);
        assert_eq!(w.len(), 2);
        let req = w.iter().find(|x| x.window == "requests").unwrap();
        assert_eq!(req.resets_at, Some(now + 360));
        assert_eq!(req.used, Some(1.0));
        let tok = w.iter().find(|x| x.window == "tokens").unwrap();
        assert_eq!(tok.resets_at, Some(now + 12));
    }

    #[test]
    fn empty_headers_yield_nothing() {
        assert!(windows_from_headers("anthropic", &headers(&[]), 0).is_empty());
        assert!(windows_from_headers(
            "openai",
            &headers(&[("content-type", "application/json")]),
            0
        )
        .is_empty());
    }

    #[test]
    fn claude_rate_limit_frame_reads_utilization_and_reset() {
        // Shape used by the community statusline tooling (used_percentage 0..100)
        // and the older 0..1 `utilization` spelling — both must work.
        let now = 1_700_000_000;
        let v = json!({
            "type": "rate_limit",
            "rate_limit_info": {
                "rateLimitType": "five_hour",
                "utilization": 0.42,
                "resetsAt": 1_700_003_600_i64,
                "status": "allowed"
            }
        });
        let w = window_from_claude_frame(&v, now).unwrap();
        assert_eq!(w.target, "claude_code");
        assert_eq!(w.window, "5h");
        assert_eq!(w.used_pct, Some(42.0));
        assert_eq!(w.resets_at, Some(1_700_003_600));
        assert_eq!(w.status.as_deref(), Some("allowed"));

        let v = json!({
            "type": "rate_limit",
            "rate_limit_info": {
                "rateLimitType": "seven_day",
                "used_percentage": 85.5,
                "resets_at": "2026-10-20T00:00:00Z"
            }
        });
        let w = window_from_claude_frame(&v, now).unwrap();
        assert_eq!(w.window, "week");
        assert_eq!(w.used_pct, Some(85.5));
        assert_eq!(w.resets_at, Some(1_792_454_400)); // 2026-10-20T00:00:00Z
    }

    #[test]
    fn unknown_claude_frame_is_ignored_without_panic() {
        assert!(window_from_claude_frame(&json!({"type":"rate_limit","rate_limit_info":{}}), 0).is_none());
        assert!(window_from_claude_frame(&json!({"foo":"bar"}), 0).is_none());
    }

    #[test]
    fn duration_parser_handles_openai_spellings() {
        assert_eq!(parse_duration_secs("12ms"), Some(0)); // sub-second rounds down
        assert_eq!(parse_duration_secs("1s"), Some(1));
        assert_eq!(parse_duration_secs("6m0s"), Some(360));
        assert_eq!(parse_duration_secs("1h2m3s"), Some(3723));
        assert_eq!(parse_duration_secs("500"), Some(500));
        assert_eq!(parse_duration_secs(""), None);
        assert_eq!(parse_duration_secs("soon"), None);
    }

    #[test]
    fn commandcode_monthly_reads_nested_and_flattened_credit_shapes() {
        let now = 1_800_000_000;
        // Verified shape: `/alpha/billing/credits` responds
        // `{ credits: { monthlyCredits… }, windowLimits: { fiveHour… } }`;
        // the period summary carries the spend.
        let nested = json!({
            "credits": { "monthlyCredits": 40.0, "purchasedCredits": 10.0, "freeCredits": 2.0 },
            "windowLimits": { "fiveHour": { "used": 6.0, "cap": 14.0 } }
        });
        let summary = json!({ "totalCost": 18.0 });
        let (w, remaining, total) = cc_monthly(&nested, Some(&summary), Some(now + 100), now);
        let w = w.expect("monthly window");
        assert_eq!(w.window, "month");
        assert_eq!(w.label, "Monthly credits");
        assert_eq!(remaining, Some(52.0));
        assert_eq!(total, Some(70.0));
        assert_eq!(w.used, Some(18.0));
        assert_eq!(w.remaining, Some(52.0));
        assert!((w.used_pct.unwrap() - 18.0 / 70.0 * 100.0).abs() < 0.01);
        assert_eq!(w.resets_at, Some(now + 100));

        // A flattened envelope (no `credits` wrapper) must not drop the row —
        // this is the "monthly usage is not showing" failure class.
        let flat = json!({ "monthlyCredits": 5.0 });
        let (w, remaining, _) = cc_monthly(&flat, None, None, now);
        let w = w.expect("flattened shape");
        assert_eq!(remaining, Some(5.0));
        assert_eq!(w.remaining, Some(5.0), "remaining-only window");
        assert!(w.used_pct.is_none());

        // Summary-only (no credit fields) still shows the spend.
        let (w, remaining, _) = cc_monthly(&json!({ "windowLimits": {} }), Some(&summary), None, now);
        assert!(remaining.is_none());
        assert_eq!(w.unwrap().used, Some(18.0));

        // Neither side reports anything: no invented window.
        assert!(cc_monthly(&json!({}), None, None, now).0.is_none());
    }

    #[test]
    fn commandcode_window_limits_classify_monthly_and_skip_unknown_keys() {
        let now = 1_700_000_000;
        let credits = json!({
            "windowLimits": {
                "fiveHour": { "used": 6.0, "cap": 14.0, "resetAt": 1_700_003_600i64 },
                "weekly": { "used": 6.3, "cap": 35.0 },
                "monthly": { "used": 9.1, "cap": 70.0, "resetAt": 1_792_000_000i64 },
                "dailySomething": { "used": 1.0, "cap": 2.0 }
            }
        });
        let w = windows_from_cc_limits(&credits, now);
        let keys: Vec<&str> = w.iter().map(|x| x.window.as_str()).collect();
        assert_eq!(w.len(), 3, "unknown keys are skipped: {keys:?}");
        assert!(keys.contains(&"5h") && keys.contains(&"week") && keys.contains(&"month"));
        let m = w.iter().find(|x| x.window == "month").unwrap();
        assert_eq!(m.label, "Monthly window");
        assert!((m.used_pct.unwrap() - 13.0).abs() < 0.01);
        assert_eq!(m.resets_at, Some(1_792_000_000));
    }

    #[test]
    fn commandcode_summary_totals_read_account_wide_numbers() {
        // The numbers the vendor's own dashboard shows (tokens/runs/$ for the
        // billing period) — Relay surfaces them verbatim.
        let summary = json!({
            "totalCost": 9.1,
            "totalCount": 2866,
            "totalTokensIn": 500_000_000i64,
            "totalTokensOut": 77_700_000i64,
            "totalTokens": 577_700_000i64
        });
        let (tokens, runs, cost) = cc_summary_totals(Some(&summary));
        assert_eq!(tokens, Some(577_700_000));
        assert_eq!(runs, Some(2866));
        assert_eq!(cost, Some(9.1));
        assert_eq!(cc_summary_totals(None), (None, None, None));
    }

    #[test]
    fn credit_fields_are_found_under_any_nesting() {
        // A deeper/renamed envelope must still yield the monthly row.
        let deep = json!({ "data": { "billing": { "credits": { "monthlyCredits": 3.0 } } } });
        let (w, remaining, _) = cc_monthly(&deep, None, None, 0);
        assert_eq!(remaining, Some(3.0));
        assert_eq!(w.unwrap().window, "month");
    }

    #[test]
    fn ts_parser_handles_seconds_millis_and_rfc3339() {
        assert_eq!(parse_ts(Some(&json!(1_700_000_000))), Some(1_700_000_000));
        assert_eq!(parse_ts(Some(&json!(1_700_000_000_000i64))), Some(1_700_000_000));
        assert_eq!(
            parse_ts(Some(&json!("2026-10-13T12:00:00Z"))),
            Some(1_791_892_800)
        );
        assert_eq!(parse_ts(None), None);
    }

    #[test]
    fn window_parts_keep_over_limit_percentages() {
        // CommandCode-style window: cap in USD, exceeded flagged.
        let now = 1_000;
        let w = window_from_parts(
            "commandcode",
            "5h",
            "5-hour window",
            "commandcode",
            &json!({"used": 15.0, "cap": 14.0, "resetAt": 999_999_999_000i64, "exceeded": true}),
            "usd",
            now,
        )
        .unwrap();
        assert!(w.used_pct.unwrap() > 100.0);
        assert_eq!(w.status.as_deref(), Some("exceeded"));
        assert_eq!(w.resets_at, Some(999_999_999));
    }

    #[test]
    fn upsert_replaces_and_prunes() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let now = now_secs();
        let mk = |pct: f64| RateWindow {
            target: "chat:anthropic".into(),
            window: "requests".into(),
            label: "Request rate limit".into(),
            source: "headers".into(),
            used_pct: Some(pct),
            used: None,
            limit: None,
            remaining: None,
            unit: "requests".into(),
            resets_at: None,
            status: None,
            observed_at: now,
        };
        upsert(&conn, vec![mk(10.0)], Vec::new());
        upsert(&conn, vec![mk(20.0)], Vec::new());
        let state = read(&conn);
        assert_eq!(state.windows.len(), 1, "same key must replace");
        assert_eq!(state.windows[0].used_pct, Some(20.0));

        // A stale window (beyond TTL) is dropped on the next save.
        let mut old = mk(30.0);
        old.observed_at = now - WINDOW_TTL_SECS - 1;
        upsert(&conn, vec![old], Vec::new());
        assert!(read(&conn).windows.is_empty());
    }

    #[test]
    fn plan_snapshot_replaces_per_source() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let mk = |remaining: f64| PlanSnapshot {
            target: "commandcode".into(),
            plan_name: Some("GOAT".into()),
            credits_remaining: Some(remaining),
            source: "commandcode".into(),
            observed_at: now_secs(),
            ..Default::default()
        };
        upsert(&conn, Vec::new(), vec![mk(70.0)]);
        upsert(&conn, Vec::new(), vec![mk(65.0)]);
        let state = read(&conn);
        assert_eq!(state.plans.len(), 1);
        assert_eq!(state.plans[0].credits_remaining, Some(65.0));
    }
}
