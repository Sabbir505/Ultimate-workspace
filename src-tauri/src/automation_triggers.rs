//! Automation trigger engines beyond cron (see
//! TRIGGERS_RAG_PRICING_CATALOG_RESEARCH.md Part A).
//!
//! A row's `trigger_type` column picks its firing engine:
//!   - `cron`   — the 30s tick + the run-due sidecar (crate::automations);
//!     behavior for these rows is 100% unchanged.
//!   - `webhook` — an inbound loopback HTTP call with a per-automation
//!     secret (crate::automation_webhook). App-open only.
//!   - `file`   — a `notify` watcher per distinct trigger path in THIS
//!     module's registry (app-open only, like every watcher).
//!   - `git`    — a HEAD-SHA comparison, run on the 30s tick in-app AND in
//!     the run-due sidecar: the only event trigger that is pure DB +
//!     `git rev-parse`, so it needs no resident process.
//!   - `gmail`  — a Gmail `historyId` comparison on the 30s tick, in-app
//!     only (needs the DB-backed OAuth refresh + network): fires on new
//!     mailbox activity in the connected Gmail account.
//!
//! Two shared disciplines:
//!   - **Dedupe state** lives in `last_trigger_state` — the last seen git
//!     SHA, or the epoch of the last fs fire. Engines follow
//!     compare-then-fire: read state, decide, write the new state, fire.
//!     A first observation (NULL state) only records — it never fires.
//!   - **Event runs never move the cron clock**: they advance
//!     `last_event_run_at`, not `last_run_at` (see db::record_run), because
//!     cron due-ness computes from `last_run_at`.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::automations::{launch_run, RunSource};
use crate::db::{self, Automation};

pub const TRIGGER_CRON: &str = "cron";
pub const TRIGGER_WEBHOOK: &str = "webhook";
pub const TRIGGER_FILE: &str = "file";
pub const TRIGGER_GIT: &str = "git";
pub const TRIGGER_GMAIL: &str = "gmail";

/// The Gmail connector id every gmail-trigger token refresh resolves through
/// (crate::connectors::oauth — same id the failure-email path uses).
const GMAIL_CONNECTOR_ID: &str = "gmail";

/// Default per-automation minimum re-fire interval for `file` triggers: a
/// churning folder (build output, log tail) would otherwise run the agent
/// continuously — every debounced burst within the window is swallowed.
pub const DEFAULT_FS_MIN_INTERVAL_SECS: u64 = 60;

// ---------------------------------------------------------------------------
// TriggerSpec — the typed shape of `trigger_config` per trigger_type
// ---------------------------------------------------------------------------

/// The parsed `trigger_config` JSON for one automation row. `webhook` carries
/// no user fields (its secret lives in the same JSON but is managed by
/// [`settle_webhook_secret`], never by the user).
#[derive(Debug, Clone, PartialEq)]
pub enum TriggerSpec {
    Webhook {},
    FsWatch {
        path: String,
        min_interval_secs: Option<u64>,
    },
    GitChange {
        cwd: String,
        branch: Option<String>,
    },
    Gmail {
        label: Option<String>,
    },
}

/// Serde shape of the `file` trigger_config (`{"path": ..., "minIntervalSecs": n}`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FsWatchConfig {
    path: String,
    #[serde(default)]
    min_interval_secs: Option<u64>,
}

/// Serde shape of the `git` trigger_config (`{"cwd": ..., "branch": ...}`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct GitChangeConfig {
    cwd: String,
    #[serde(default)]
    branch: Option<String>,
}

/// Serde shape of the `gmail` trigger_config (`{"label": ...}` — optional;
/// absent/empty reads as the account default, "inbox").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct GmailConfig {
    #[serde(default)]
    label: Option<String>,
}

impl TriggerSpec {
    /// Parse the (trigger_type, trigger_config) pair. Returns Ok(None) for
    /// cron rows (no config to parse), Err for unknown types / malformed
    /// JSON — the command layer rejects those up front, the engines just
    /// skip rows that fail here.
    pub fn parse(trigger_type: &str, config_json: &str) -> Result<Option<TriggerSpec>, String> {
        let raw: serde_json::Value = if config_json.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(config_json)
                .map_err(|e| format!("invalid trigger_config JSON: {e}"))?
        };
        match trigger_type {
            TRIGGER_CRON | "" => Ok(None),
            TRIGGER_WEBHOOK => Ok(Some(TriggerSpec::Webhook {})),
            TRIGGER_FILE => {
                let cfg: FsWatchConfig = serde_json::from_value(raw)
                    .map_err(|e| format!("invalid file trigger_config: {e}"))?;
                Ok(Some(TriggerSpec::FsWatch {
                    path: cfg.path,
                    min_interval_secs: cfg.min_interval_secs,
                }))
            }
            TRIGGER_GIT => {
                let cfg: GitChangeConfig = serde_json::from_value(raw)
                    .map_err(|e| format!("invalid git trigger_config: {e}"))?;
                Ok(Some(TriggerSpec::GitChange {
                    cwd: cfg.cwd,
                    branch: cfg.branch,
                }))
            }
            TRIGGER_GMAIL => {
                let cfg: GmailConfig = serde_json::from_value(raw)
                    .map_err(|e| format!("invalid gmail trigger_config: {e}"))?;
                Ok(Some(TriggerSpec::Gmail {
                    // A blank label reads as "not set" (the account default);
                    // any other value is accepted verbatim — Gmail label ids
                    // are user-defined strings, so there is no list to
                    // validate against.
                    label: cfg
                        .label
                        .map(|l| l.trim().to_string())
                        .filter(|l| !l.is_empty()),
                }))
            }
            other => Err(format!(
                "unknown trigger type '{other}' (expected cron | webhook | file | git | gmail)"
            )),
        }
    }

    /// The canonical config JSON for this spec (what create/update stores).
    pub fn to_config_json(&self) -> String {
        match self {
            TriggerSpec::Webhook {} => "{}".to_string(),
            TriggerSpec::FsWatch {
                path,
                min_interval_secs,
            } => serde_json::to_string(&FsWatchConfig {
                path: path.clone(),
                min_interval_secs: *min_interval_secs,
            })
            .unwrap_or_else(|_| "{}".to_string()),
            TriggerSpec::GitChange { cwd, branch } => serde_json::to_string(&GitChangeConfig {
                cwd: cwd.clone(),
                branch: branch.clone(),
            })
            .unwrap_or_else(|_| "{}".to_string()),
            TriggerSpec::Gmail { label } => serde_json::to_string(&GmailConfig {
                label: label.clone(),
            })
            .unwrap_or_else(|_| "{}".to_string()),
        }
    }

    /// Normalize a user/tool supplied trigger_type ("", None → cron).
    pub fn normalize_type(t: Option<&str>) -> String {
        match t.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => s.to_lowercase(),
            None => TRIGGER_CRON.to_string(),
        }
    }
}

/// Command-layer validation for one automation's trigger triple. For cron
/// rows this is exactly the old cron-schedule check; for event rows the
/// `schedule` may be empty and the config must parse instead.
pub fn validate_trigger(
    trigger_type: &str,
    trigger_config: &str,
    schedule: &str,
) -> Result<(), String> {
    match TriggerSpec::parse(trigger_type, trigger_config)? {
        None => crate::automations::validate_schedule(schedule),
        Some(TriggerSpec::Webhook {}) => Ok(()),
        Some(TriggerSpec::FsWatch { path, .. }) => {
            if path.trim().is_empty() {
                Err("file trigger requires a non-empty \"path\"".into())
            } else {
                Ok(())
            }
        }
        Some(TriggerSpec::GitChange { cwd, branch }) => {
            if cwd.trim().is_empty() {
                Err("git trigger requires a non-empty \"cwd\"".into())
            } else if branch.as_deref().map(str::trim).is_some_and(str::is_empty) {
                Err("git trigger \"branch\" must be non-empty when given".into())
            } else {
                Ok(())
            }
        }
        // Gmail rows accept an empty schedule like every other event
        // trigger, and the label is free-form (a blank one was already
        // normalized to None in parse — there is no label list to check).
        Some(TriggerSpec::Gmail { .. }) => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Webhook secret handling (stored inside trigger_config: {"secret": ...})
// ---------------------------------------------------------------------------

/// 32-char URL-safe random secret — the same RNG idiom as the mobile relay's
/// pairing token (mobile/relay.rs::new_pairing_token).
pub fn generate_webhook_secret() -> String {
    let mut bytes = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The automation's webhook secret, when its trigger_config carries one.
pub fn secret_for(a: &Automation) -> Option<String> {
    let raw: serde_json::Value = serde_json::from_str(&a.trigger_config).ok()?;
    raw.get("secret")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Fill in the webhook secret for a create/update. Create (existing = None)
/// generates a fresh secret when none was supplied; update carries over the
/// stored row's secret when the incoming config doesn't have one — the
/// list/get IPC redacts the secret, so a UI round-trip NEVER has it and must
/// not rotate it (that would invalidate every existing trigger URL).
pub fn settle_webhook_secret(
    input: &mut crate::db::AutomationInput,
    existing: Option<&Automation>,
) {
    if input.trigger_type.as_deref() != Some(TRIGGER_WEBHOOK) {
        return;
    }
    let mut raw: serde_json::Value = input
        .trigger_config
        .as_deref()
        .and_then(|c| serde_json::from_str(c).ok())
        .filter(|v: &serde_json::Value| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let has_secret = raw
        .get("secret")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty());
    if !has_secret {
        let carried = existing.and_then(secret_for);
        let secret = carried.unwrap_or_else(generate_webhook_secret);
        raw["secret"] = serde_json::Value::String(secret);
    }
    input.trigger_config = Some(raw.to_string());
}

/// Redact the webhook secret from a row's trigger_config — used by every
/// list/get IPC surface so the secret reaches the UI only through the
/// dedicated `automation_webhook_info` getter.
pub fn strip_webhook_secret(a: &mut Automation) {
    if a.trigger_type != TRIGGER_WEBHOOK {
        return;
    }
    if let Ok(mut raw) = serde_json::from_str::<serde_json::Value>(&a.trigger_config) {
        if let Some(obj) = raw.as_object_mut() {
            if obj.remove("secret").is_some() {
                a.trigger_config = raw.to_string();
            }
        }
    }
}

/// Constant-time secret comparison for the webhook listener. The length
/// pre-check is required by `subtle`'s slice equality; length itself is not
/// secret-critical (a wrong-length guess already fails).
pub fn secret_matches(expected: &str, provided: &str) -> bool {
    use subtle::ConstantTimeEq;
    expected.len() == provided.len() && bool::from(expected.as_bytes().ct_eq(provided.as_bytes()))
}

// ---------------------------------------------------------------------------
// Git triggers — HEAD-SHA compare on the shared 30s tick (and the sidecar)
// ---------------------------------------------------------------------------

/// Evaluate every enabled `git`-triggered automation. Returns the ids whose
/// HEAD changed since the last evaluation (first sighting records without
/// firing — an app upgrade or watcher install must not retro-fire).
/// A missing repo / git failure skips the row silently.
pub fn evaluate_git_triggers(db: &Arc<Mutex<Connection>>) -> Vec<String> {
    let candidates: Vec<Automation> = {
        let conn = db.lock();
        db::list_automations(&conn)
            .unwrap_or_default()
            .into_iter()
            .filter(|a| a.enabled && a.trigger_type == TRIGGER_GIT)
            .collect()
    };
    let mut fired = Vec::new();
    for a in candidates {
        let Ok(Some(TriggerSpec::GitChange { cwd, branch })) =
            TriggerSpec::parse(&a.trigger_type, &a.trigger_config)
        else {
            continue;
        };
        let Some(head) = git_rev_parse(&cwd, branch.as_deref()) else {
            continue;
        };
        if !should_fire_git(a.last_trigger_state.as_deref(), &head) {
            // First sighting (or unchanged HEAD): record, don't fire.
            if a.last_trigger_state.as_deref() != Some(head.as_str()) {
                let conn = db.lock();
                let _ = db::set_automation_trigger_state(&conn, &a.id, &head);
            }
            continue;
        }
        {
            let conn = db.lock();
            let _ = db::set_automation_trigger_state(&conn, &a.id, &head);
        }
        fired.push(a.id);
    }
    fired
}

/// The git state machine: fire only on an OBSERVED CHANGE. First-seen
/// (NULL state) just records.
fn should_fire_git(prev_state: Option<&str>, head: &str) -> bool {
    matches!(prev_state, Some(prev) if prev != head)
}

/// `git -C <cwd> rev-parse <rev>` with a hard 5s bound (a wedged git, a hung
/// network filesystem or an NFS-stale repo must not hold the 30s tick).
/// Any failure — including a missing repo — is None.
fn git_rev_parse(cwd: &str, branch: Option<&str>) -> Option<String> {
    let rev = branch.unwrap_or("HEAD");
    let mut child = Command::new("git")
        .args(["-C", cwd, "rev-parse", rev])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let exited = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break None,
        }
    };
    // rev-parse prints one short line (~41 bytes) — reading it after exit
    // cannot deadlock the way reading a full child's output can.
    if !exited?.success() {
        return None;
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let sha = out.trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

// ---------------------------------------------------------------------------
// Gmail triggers — historyId compare on the 30s tick (app-open only)
// ---------------------------------------------------------------------------

/// Evaluate every enabled `gmail`-triggered automation. Returns the ids that
/// observed a Gmail `historyId` change (first sighting records WITHOUT
/// firing — connecting the connector or upgrading the app must not
/// retro-fire every stored row, the same rule as the git path).
///
/// Failures skip silently: "connector not connected" is the everyday case,
/// and a transient API hiccup must not spam stderr every 30s.
///
/// v1 label note: the trigger's optional `label` is stored and shown, but
/// NOT used to narrow the poll — the engine compares the account-wide
/// `users.profile.historyId`, so ANY mailbox activity fires. Narrowing per
/// label needs `users.history.list?labelId=…&startHistoryId=…` (a second API
/// surface with its own expiry semantics), deliberately left out of v1.
/// There is no message-content filtering either.
///
/// Async discipline: one task per automation is spawned and joined here, and
/// the DB mutex is only ever taken inside scoped blocks — never across an
/// await (the failure-email path in automations.rs shows the same pattern).
/// App-open only: the run-due sidecar never calls this (it has neither a
/// tokio reactor nor a reason to refresh OAuth tokens).
pub async fn evaluate_gmail_triggers(db: &Arc<Mutex<Connection>>) -> Vec<String> {
    let candidates: Vec<Automation> = {
        let conn = db.lock();
        db::list_automations(&conn)
            .unwrap_or_default()
            .into_iter()
            .filter(|a| a.enabled && a.trigger_type == TRIGGER_GMAIL)
            .collect()
    };
    if candidates.is_empty() {
        return Vec::new();
    }
    let mut handles = Vec::with_capacity(candidates.len());
    for a in candidates {
        let db = Arc::clone(db);
        handles.push(tauri::async_runtime::spawn(async move {
            poll_gmail_automation(&db, &a).await
        }));
    }
    let mut fired = Vec::new();
    for h in handles {
        if let Ok(Some(id)) = h.await {
            fired.push(id);
        }
    }
    fired
}

/// One row's poll: token → profile `historyId` → compare-then-store (the
/// shared dedupe protocol). Returns the automation id when the caller should
/// FIRE (launch_run applies the RUNNING overlap guard, as for every source).
async fn poll_gmail_automation(db: &Arc<Mutex<Connection>>, a: &Automation) -> Option<String> {
    // Same token path the failure email uses: DB-backed OAuth refresh, no
    // AppHandle needed.
    let token = crate::connectors::oauth::ensure_valid_access_token_with_db(db, GMAIL_CONNECTOR_ID)
        .await
        .ok()?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("relay-desktop")
        .build()
        .ok()?;
    let resp = http
        .get("https://gmail.googleapis.com/gmail/v1/users/me/profile")
        .bearer_auth(&token)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let history_id = body
        .get("historyId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let changed = should_fire_gmail(a.last_trigger_state.as_deref(), &history_id);
    {
        let conn = db.lock();
        let _ = db::set_automation_trigger_state(&conn, &a.id, &history_id);
    }
    changed.then(|| a.id.clone())
}

/// The gmail state machine — the git one's twin: fire only on an OBSERVED
/// change; first sighting (NULL state) just records.
fn should_fire_gmail(prev_state: Option<&str>, history_id: &str) -> bool {
    matches!(prev_state, Some(prev) if prev != history_id)
}

// ---------------------------------------------------------------------------
// File triggers — one notify watcher per distinct trigger path (app-open)
// ---------------------------------------------------------------------------

/// Quiet window after the last FS event before the burst fires — 1s per the
/// trigger design (the git UI watcher uses 300ms; automation runs cost
/// seconds, so 1s costs nothing and collapses more of a burst).
const FS_DEBOUNCE: Duration = Duration::from_secs(1);
/// Ceiling on a single debounce burst — sustained activity must still fire.
const FS_MAX_BURST: Duration = Duration::from_secs(10);

/// Active fs-trigger watchers, keyed by CANONICALIZED path (verbatim
/// `\\?\C:\…` on Windows). File-scope static, like the scheduler's RUNNING
/// set — the registry must be reachable from both the boot hook and the CRUD
/// commands without threading another Tauri-managed type through everything.
static FS_WATCHERS: Lazy<Mutex<HashMap<PathBuf, RecommendedWatcher>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Reconcile the watcher registry with what the DB wants: install watchers
/// for every distinct, existing trigger path of every ENABLED `file`-row and
/// drop watchers whose path no longer qualifies (row deleted / disabled /
/// path edited). Called at boot (lib.rs, after the git watcher install) and
/// after every automation create/update/delete/enable-toggle.
pub fn sync_fs_watchers(app: &AppHandle, db: &Arc<Mutex<Connection>>) {
    let desired: Vec<PathBuf> = {
        let conn = db.lock();
        fs_trigger_paths(&conn)
    };
    let mut watchers = FS_WATCHERS.lock();
    // Teardown first: paths no longer wanted. Both path forms are removed
    // (the git_watcher::uninstall lesson): when the watched directory itself
    // was deleted, canonicalize fails, the raw path becomes the key, and a
    // canonical-only remove would leak the watcher + its thread forever.
    let wanted: std::collections::HashSet<&PathBuf> = desired.iter().collect();
    let stale: Vec<PathBuf> = watchers
        .keys()
        .filter(|k| !wanted.contains(k))
        .cloned()
        .collect();
    for key in stale {
        watchers.remove(&key);
    }
    // Install the missing ones.
    for path in desired {
        if watchers.contains_key(&path) {
            continue;
        }
        if let Some(w) = install_fs_watcher(app, db, &path) {
            watchers.insert(path, w);
        }
    }
}

/// Distinct canonicalized trigger paths of every enabled `file` automation.
fn fs_trigger_paths(conn: &Connection) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for a in db::list_automations(conn).unwrap_or_default() {
        if !a.enabled || a.trigger_type != TRIGGER_FILE {
            continue;
        }
        let Ok(Some(TriggerSpec::FsWatch { path, .. })) =
            TriggerSpec::parse(&a.trigger_type, &a.trigger_config)
        else {
            continue;
        };
        // A path that doesn't exist can't be watched; it comes back if the
        // directory is created and any CRUD re-syncs.
        if let Ok(canon) = Path::new(&path).canonicalize() {
            if !out.contains(&canon) {
                out.push(canon);
            }
        }
    }
    out
}

/// Build one watcher + debouncer thread for `canon`. The watcher is returned
/// to the caller (which keeps it in the registry); dropping it later
/// disconnects the mpsc channel and the thread exits by itself.
fn install_fs_watcher(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    canon: &Path,
) -> Option<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(
        move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if matches!(
                    ev.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) {
                    let _ = tx.send(());
                }
            }
        },
    ) {
        Ok(w) => w,
        Err(e) => {
            crate::relay_eprintln!("[automation-triggers] watcher create failed for {}: {e}", canon.display());
            return None;
        }
    };
    if let Err(e) = watcher.watch(canon, RecursiveMode::Recursive) {
        crate::relay_eprintln!("[automation-triggers] watch failed for {}: {e}", canon.display());
        return None;
    }
    let app = app.clone();
    let db = Arc::clone(db);
    let canon = canon.to_path_buf();
    let _ = thread_with_name(format!("automation-fs-watch-{}", canon.display()), move || {
        loop {
            match rx.recv() {
                Ok(()) => {
                    // Debounce: drain a 1s quiet window, ceiling FS_MAX_BURST
                    // (the git_watcher idiom, with automation-sized windows).
                    let burst_deadline = Instant::now() + FS_MAX_BURST;
                    while Instant::now() < burst_deadline {
                        match rx.recv_timeout(FS_DEBOUNCE) {
                            Ok(()) => {}
                            Err(mpsc::RecvTimeoutError::Timeout) => break,
                            Err(mpsc::RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    fire_fs_automations(&app, &db, &canon);
                }
                Err(_) => return, // watcher dropped — registry removed it
            }
        }
    });
    Some(watcher)
}

/// Named-thread spawn (matches the git_watcher/vault watcher idiom; the name
/// shows up in crash dumps). Fails only when the OS refuses a new thread.
fn thread_with_name(
    name: String,
    f: impl FnOnce() + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new().name(name).spawn(f)
}

/// Every enabled `file` automation watching `canon` fires — subject to its
/// own minimum re-fire interval, stored as the last-fire epoch in
/// `last_trigger_state` (None = never fired → fire).
fn fire_fs_automations(app: &AppHandle, db: &Arc<Mutex<Connection>>, canon: &Path) {
    let now = db::now_ts();
    let to_fire: Vec<Automation> = {
        let conn = db.lock();
        db::list_automations(&conn)
            .unwrap_or_default()
            .into_iter()
            .filter(|a| a.enabled && a.trigger_type == TRIGGER_FILE)
            .filter(|a| {
                matches!(
                    TriggerSpec::parse(&a.trigger_type, &a.trigger_config),
                    Ok(Some(TriggerSpec::FsWatch { path, .. }))
                        if Path::new(&path).canonicalize().is_ok_and(|p| p == canon)
                )
            })
            .filter(|a| {
                // Minimum re-fire interval (default when absent), honored via
                // the last-fire epoch in last_trigger_state.
                let min = match TriggerSpec::parse(&a.trigger_type, &a.trigger_config) {
                    Ok(Some(TriggerSpec::FsWatch {
                        min_interval_secs: Some(v),
                        ..
                    })) => v,
                    _ => DEFAULT_FS_MIN_INTERVAL_SECS,
                };
                let last = a
                    .last_trigger_state
                    .as_deref()
                    .and_then(|s| s.parse::<i64>().ok());
                last.is_none_or(|t| now - t >= min as i64)
            })
            .collect()
    };
    for a in to_fire {
        // Advance the last-fire epoch BEFORE launching: the run takes
        // seconds-to-minutes, and a burst landing mid-run must be swallowed
        // by the interval, not re-fire after it.
        {
            let conn = db.lock();
            let _ = db::set_automation_trigger_state(&conn, &a.id, &now.to_string());
        }
        if let Err(e) = launch_run(Some(app), db, &a, RunSource::FsWatch) {
            crate::relay_eprintln!("[automation-triggers] fs launch failed for {}: {e}", a.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, trigger_type: Option<String>, trigger_config: Option<String>) -> crate::db::AutomationInput {
        crate::db::AutomationInput {
            name: name.into(),
            prompt: "p".into(),
            harness: "claude_code".into(),
            model: None,
            cwd: None,
            schedule: String::new(),
            enabled: Some(true),
            origin: None,
            trigger_type,
            trigger_config,
        }
    }

    #[test]
    fn trigger_config_parse_serialize_round_trips() {
        // file, with and without the optional interval
        let fs = TriggerSpec::FsWatch { path: "D:/watch".into(), min_interval_secs: Some(30) };
        assert_eq!(
            TriggerSpec::parse("file", &fs.to_config_json()).unwrap(),
            Some(fs.clone())
        );
        let fs_default = TriggerSpec::FsWatch { path: "/tmp/x".into(), min_interval_secs: None };
        assert_eq!(
            TriggerSpec::parse("file", &fs_default.to_config_json()).unwrap(),
            Some(fs_default)
        );
        // The stored JSON is camelCase on the wire.
        assert!(fs.to_config_json().contains("minIntervalSecs"));
        assert_eq!(fs.to_config_json().contains("min_interval_secs"), false);

        // git, with and without branch
        let git = TriggerSpec::GitChange { cwd: "D:/repo".into(), branch: Some("main".into()) };
        assert_eq!(
            TriggerSpec::parse("git", &git.to_config_json()).unwrap(),
            Some(git.clone())
        );
        assert!(git.to_config_json().contains("main"));
        let git_plain = TriggerSpec::GitChange { cwd: "D:/repo".into(), branch: None };
        assert_eq!(
            TriggerSpec::parse("git", &git_plain.to_config_json()).unwrap(),
            Some(git_plain)
        );

        // webhook round-trips through the empty object
        assert_eq!(
            TriggerSpec::parse("webhook", "{}").unwrap(),
            Some(TriggerSpec::Webhook {})
        );
        assert_eq!(TriggerSpec::Webhook {}.to_config_json(), "{}");

        // gmail: label round-trips; absent/blank reads as None (default
        // inbox), like webhook the config is optional on the wire.
        let gmail = TriggerSpec::Gmail { label: Some("inbox".into()) };
        assert_eq!(
            TriggerSpec::parse("gmail", &gmail.to_config_json()).unwrap(),
            Some(gmail.clone())
        );
        assert!(gmail.to_config_json().contains("inbox"));
        assert_eq!(
            TriggerSpec::parse("gmail", "{}").unwrap(),
            Some(TriggerSpec::Gmail { label: None })
        );
        assert_eq!(
            TriggerSpec::parse("gmail", "").unwrap(),
            Some(TriggerSpec::Gmail { label: None })
        );
        assert_eq!(
            TriggerSpec::parse("gmail", "{\"label\":\"  \"}").unwrap(),
            Some(TriggerSpec::Gmail { label: None })
        );

        // cron rows have no spec; webhook works with a bare empty object.
        assert_eq!(TriggerSpec::parse("cron", "{}").unwrap(), None);
        assert_eq!(TriggerSpec::parse("cron", "").unwrap(), None);
        // file/git configs carry REQUIRED fields — an empty config is a
        // validation error, not a silent default.
        assert!(TriggerSpec::parse("file", "").is_err());
        assert!(TriggerSpec::parse("file", "{}").is_err());
        assert!(TriggerSpec::parse("git", "").is_err());
        assert!(TriggerSpec::parse("git", "{}").is_err());
        assert!(TriggerSpec::parse("webhook", "").is_ok());
    }

    #[test]
    fn trigger_parse_rejects_unknown_type_and_bad_json() {
        assert!(TriggerSpec::parse("imap", "{}").is_err());
        assert!(TriggerSpec::parse("file", "not json").is_err());
        assert!(TriggerSpec::parse("file", "{\"path\": 3}").is_err());
        assert!(TriggerSpec::parse("git", "[]").is_err());
    }

    #[test]
    fn validate_trigger_degrades_schedule_check_for_event_rows() {
        // cron: empty schedule rejected (unchanged behavior)
        assert!(validate_trigger("cron", "{}", "").is_err());
        assert!(validate_trigger("cron", "{}", "2 9 * * 1-5").is_ok());
        // event rows: schedule may be empty; config must be well-formed
        assert!(validate_trigger("webhook", "{}", "").is_ok());
        assert!(validate_trigger("file", "{\"path\":\"D:/x\"}", "").is_ok());
        assert!(validate_trigger("file", "{\"path\":\"\"}", "").is_err());
        assert!(validate_trigger("git", "{\"cwd\":\"D:/r\"}", "").is_ok());
        assert!(validate_trigger("git", "{\"branch\":\"  \"}", "").is_err());
        // gmail: empty schedule + any label (even a blank one, normalized
        // away) are accepted — there is no label list to validate against.
        assert!(validate_trigger("gmail", "{}", "").is_ok());
        assert!(validate_trigger("gmail", "{\"label\":\"inbox\"}", "").is_ok());
        assert!(validate_trigger("gmail", "{\"label\":\"  \"}", "").is_ok());
        assert!(validate_trigger("gmail", "{}", "2 9 * * *").is_ok());
        assert!(validate_trigger("nope", "{}", "").is_err());
    }

    #[test]
    fn git_state_machine_fires_only_on_observed_change() {
        // First sighting never fires.
        assert!(!should_fire_git(None, "abc123"));
        // Same HEAD again: nothing.
        assert!(!should_fire_git(Some("abc123"), "abc123"));
        // A new commit fires.
        assert!(should_fire_git(Some("abc123"), "def456"));
    }

    #[test]
    fn gmail_state_machine_fires_only_on_observed_change() {
        // First sighting (no stored historyId) records without firing.
        assert!(!should_fire_gmail(None, "12345"));
        // Unchanged mailbox activity counter: nothing.
        assert!(!should_fire_gmail(Some("12345"), "12345"));
        // New activity fires.
        assert!(should_fire_gmail(Some("12345"), "12399"));
    }

    #[test]
    fn webhook_secret_compare_is_exact() {
        let secret = generate_webhook_secret();
        assert_eq!(secret.len(), 32, "24 bytes → 32 url-safe chars");
        assert!(secret_matches(&secret, &secret));
        let mut wrong = secret.clone();
        wrong.replace_range(31..32, "x");
        assert!(!secret_matches(&secret, &wrong));
        assert!(!secret_matches(&secret, &"x".repeat(32)));
        // Different lengths never panic.
        assert!(!secret_matches(&secret, ""));
        assert!(!secret_matches(&secret, &"x".repeat(33)));
    }

    #[test]
    fn settle_webhook_secret_generates_then_preserves() {
        let mut created = input(
            "w",
            Some("webhook".into()),
            None,
        );
        settle_webhook_secret(&mut created, None);
        let fresh = secret_for(&Automation {
            id: "x".into(),
            name: "w".into(),
            prompt: String::new(),
            harness: String::new(),
            model: String::new(),
            cwd: String::new(),
            schedule: String::new(),
            enabled: true,
            last_run_at: None,
            last_status: None,
            chat_session_id: None,
            created_at: 0,
            origin: "user".into(),
            trigger_type: "webhook".into(),
            trigger_config: created.trigger_config.clone().unwrap(),
            last_trigger_state: None,
            last_event_run_at: None,
        });
        assert!(fresh.is_some(), "create generates a secret");

        // Update round-trip (the IPC redacted the secret away) carries the
        // stored one instead of rotating it.
        let mut updated = input(
            "w",
            Some("webhook".into()),
            Some("{\"path\":null}".into()),
        );
        let existing = fresh_row_with_config(format!("{{\"secret\":\"{}\"}}", fresh.unwrap()));
        settle_webhook_secret(&mut updated, Some(&existing));
        assert_eq!(
            secret_for(&fresh_row_with_config(updated.trigger_config.clone().unwrap())),
            secret_for(&existing),
            "existing secret survives a secret-less update"
        );

        // An explicit secret in the incoming config wins (rotation on purpose).
        let mut rotated = input(
            "w",
            Some("webhook".into()),
            Some("{\"secret\":\"brand-new\"}".into()),
        );
        settle_webhook_secret(&mut rotated, Some(&existing));
        assert_eq!(
            secret_for(&fresh_row_with_config(rotated.trigger_config.clone().unwrap()))
                .as_deref(),
            Some("brand-new")
        );
    }

    fn fresh_row_with_config(config: String) -> Automation {
        Automation {
            id: "x".into(),
            name: "w".into(),
            prompt: String::new(),
            harness: String::new(),
            model: String::new(),
            cwd: String::new(),
            schedule: String::new(),
            enabled: true,
            last_run_at: None,
            last_status: None,
            chat_session_id: None,
            created_at: 0,
            origin: "user".into(),
            trigger_type: "webhook".into(),
            trigger_config: config,
            last_trigger_state: None,
            last_event_run_at: None,
        }
    }

    #[test]
    fn strip_webhook_secret_redacts_only_the_secret() {
        let mut a = fresh_row_with_config("{\"secret\":\"s3cret\",\"note\":\"keep\"}".into());
        strip_webhook_secret(&mut a);
        assert!(!a.trigger_config.contains("s3cret"));
        assert!(a.trigger_config.contains("keep"));

        // Non-webhook rows pass through untouched (even if a stray secret
        // field existed there, it isn't ours to redact).
        let mut cron = fresh_row_with_config("{\"secret\":\"x\"}".into());
        cron.trigger_type = "cron".into();
        strip_webhook_secret(&mut cron);
        assert!(cron.trigger_config.contains("x"));
    }

    /// Real-repo state machine: first evaluation records, a new commit fires
    /// exactly once, an unchanged HEAD does not fire again.
    #[test]
    fn evaluate_git_triggers_fires_once_per_commit() {
        let repo = tempfile::tempdir().unwrap();
        git(&repo, &["init"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        git(&repo, &["config", "user.name", "t"]);

        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let a = {
            let conn = db.lock();
            crate::db::create_automation(
                &conn,
                &input(
                    "git-triggered",
                    Some("git".into()),
                    Some(format!("{{\"cwd\":\"{}\"}}", repo.path().to_string_lossy().replace('\\', "/"))),
                ),
            )
            .unwrap()
        };

        // Empty repo → rev-parse fails → skip silently, no fire, no state.
        assert!(evaluate_git_triggers(&db).is_empty());

        // First commit: first sighting records without firing.
        std::fs::write(repo.path().join("f.txt"), "one").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "one"]);
        assert_eq!(evaluate_git_triggers(&db), Vec::<String>::new());
        let state_after_first = {
            let conn = db.lock();
            crate::db::get_automation(&conn, &a.id).unwrap().unwrap().last_trigger_state
        };
        assert!(state_after_first.is_some(), "first sighting records HEAD");

        // Unchanged HEAD: still nothing.
        assert_eq!(evaluate_git_triggers(&db), Vec::<String>::new());

        // Second commit: fires exactly once.
        std::fs::write(repo.path().join("f.txt"), "two").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "two"]);
        assert_eq!(evaluate_git_triggers(&db), vec![a.id.clone()]);
        assert_eq!(evaluate_git_triggers(&db), Vec::<String>::new());
    }

    #[test]
    fn evaluate_git_triggers_ignores_disabled_and_cron_rows() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let db = Arc::new(Mutex::new(conn));
        {
            let conn = db.lock();
            // A cron row whose cwd looks like a repo must stay cron-only.
            crate::db::create_automation(
                &conn,
                &input(
                    "cron-row",
                    None,
                    Some("{\"cwd\":\"D:/nowhere\"}".into()),
                ),
            )
            .unwrap();
        }
        assert!(evaluate_git_triggers(&db).is_empty());
    }

    fn git(dir: &tempfile::TempDir, args: &[&str]) {
        let out = Command::new("git")
            .args(["-C", dir.path().to_string_lossy().as_ref()])
            .args(args)
            .stdin(Stdio::null())
            .output()
            .expect("git must be available in dev/CI");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
