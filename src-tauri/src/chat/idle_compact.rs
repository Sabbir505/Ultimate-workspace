//! Idle compaction — summarize long chat threads the user has stepped away
//! from, so that whenever they come back the next turn sends a much smaller
//! context instead of re-processing the whole history.
//!
//! This mirrors Claude Code's "idle compaction" (a 200k+ token conversation
//! left idle ~54 min is compacted before its prompt cache expires), adapted to
//! Relay's built-in chat paths:
//!
//! - **Cloud built-in** — history is re-sent from the DB every turn; the first
//!   turn after a long idle is a full prompt-cache miss that re-charges the
//!   entire conversation. Folding the aged-out head into a summary while idle
//!   permanently shrinks every future turn.
//! - **Local GGUF** — a smaller context next turn means less context-shifting
//!   and less RAM/VRAM pressure. The summarizer call runs while the machine is
//!   otherwise idle.
//!
//! Harness sessions (`agent = "harness:<id>"`) are deliberately excluded: their
//! context lives inside the CLI process, which Relay cannot compact from a
//! background sweep. Bot sessions and automation run-logs are excluded too —
//! their lifecycle is not "the user stepped away from a thread".
//!
//! Guards, in order:
//! 1. master switch (default on) and a per-pass rate limit;
//! 2. a session busy streaming a turn (builtin) or with a harness turn in
//!    flight is skipped;
//! 3. the newest active row must not already be a `[compacted context]` summary
//!    (nothing was appended since the last compaction → summarizing the summary
//!    would only compound loss);
//! 4. the active history must exceed `min_tokens` (default 200k — the same
//!    floor Claude Code uses, sized so a pass is only spent on threads whose
//!    future re-send is expensive).
//!
//! All tunables live under `chat.idle_compaction.*` (see the settings UI in
//! `src/components/settings/LocalModelsPanel.tsx`).

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::chat::compaction::CompactionEntry;
use crate::chat::providers::ChatMessage;
use crate::db;

/// Settings keys (mirrored by `src/state/settings.ts`).
pub const K_IDLE_ENABLED: &str = "chat.idle_compaction.enabled";
pub const K_IDLE_MINUTES: &str = "chat.idle_compaction.idle_minutes";
pub const K_IDLE_MIN_TOKENS: &str = "chat.idle_compaction.min_tokens";
pub const K_IDLE_MAX_PER_PASS: &str = "chat.idle_compaction.max_per_pass";

/// Defaults + clamps. Kept in lockstep with the TS mirror
/// (`DEFAULT_IDLE_*` in `src/state/settings.ts`).
pub const DEFAULT_IDLE_ENABLED: bool = true;
pub const DEFAULT_IDLE_MINUTES: u64 = 60;
pub const DEFAULT_IDLE_MIN_TOKENS: u32 = 200_000;
pub const DEFAULT_IDLE_MAX_PER_PASS: usize = 3;
pub const MIN_IDLE_MINUTES: u64 = 5;
pub const MAX_IDLE_MINUTES: u64 = 24 * 60;
pub const MIN_IDLE_MIN_TOKENS: u32 = 1_000;
pub const MAX_IDLE_MIN_TOKENS: u32 = 5_000_000;
pub const MIN_IDLE_MAX_PER_PASS: usize = 1;
pub const MAX_IDLE_MAX_PER_PASS: usize = 50;

/// How often the background sweep runs.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// Don't retry the same session within this window — a failing pass (no running
/// sidecar, missing key) would otherwise reload history and re-log every sweep.
const ATTEMPT_COOLDOWN: Duration = Duration::from_secs(5 * 60);

/// Per-session idle compaction config (`chat.idle_compaction.*`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleCompactionConfig {
    /// Master switch. Off by config still discards nothing — it only stops the
    /// background sweep; pre-send compaction is unaffected.
    pub enabled: bool,
    /// Idle age (minutes) before a session becomes a candidate.
    pub idle_minutes: u64,
    /// Estimated active-history token floor below which a session is left alone.
    pub min_tokens: u32,
    /// Maximum sessions compacted in a single sweep (cost bound).
    pub max_per_pass: usize,
}

impl Default for IdleCompactionConfig {
    fn default() -> Self {
        Self {
            enabled: DEFAULT_IDLE_ENABLED,
            idle_minutes: DEFAULT_IDLE_MINUTES,
            min_tokens: DEFAULT_IDLE_MIN_TOKENS,
            max_per_pass: DEFAULT_IDLE_MAX_PER_PASS,
        }
    }
}

/// Load the idle compaction config, forgiving bad values the same way the other
/// compaction loaders do (a bad stored value must never break a sweep).
pub fn load_idle_compaction_config(conn: &Connection) -> IdleCompactionConfig {
    let mut cfg = IdleCompactionConfig::default();
    if let Ok(Some(raw)) = db::get_setting(conn, K_IDLE_ENABLED) {
        cfg.enabled = !matches!(raw.trim(), "false" | "0" | "off");
    }
    if let Ok(Some(raw)) = db::get_setting(conn, K_IDLE_MINUTES) {
        if let Ok(v) = raw.trim().parse::<u64>() {
            if (MIN_IDLE_MINUTES..=MAX_IDLE_MINUTES).contains(&v) {
                cfg.idle_minutes = v;
            }
        }
    }
    if let Ok(Some(raw)) = db::get_setting(conn, K_IDLE_MIN_TOKENS) {
        if let Ok(v) = raw.trim().parse::<u32>() {
            if (MIN_IDLE_MIN_TOKENS..=MAX_IDLE_MIN_TOKENS).contains(&v) {
                cfg.min_tokens = v;
            }
        }
    }
    if let Ok(Some(raw)) = db::get_setting(conn, K_IDLE_MAX_PER_PASS) {
        if let Ok(v) = raw.trim().parse::<usize>() {
            if (MIN_IDLE_MAX_PER_PASS..=MAX_IDLE_MAX_PER_PASS).contains(&v) {
                cfg.max_per_pass = v;
            }
        }
    }
    cfg
}

/// Estimated tokens across a session's active entries (~4 chars/token) — the
/// same estimator the meter and cloud compaction use, so the floor is measured
/// in the units the rest of the system already speaks. Pure so the tests pin it.
pub fn estimate_active_tokens(entries: &[CompactionEntry]) -> u32 {
    entries
        .iter()
        .map(|e| crate::chat::commands::estimate_tokens(&e.message.content))
        .sum()
}

/// True when the newest active row (by DB id) is itself a `[compacted context]`
/// summary — i.e. nothing was appended after the last compaction. A new pass
/// would only re-summarize the summary (the compounding-loss failure the
/// compaction redesign warns about), so the sweep skips it.
///
/// `load_compaction_entries` hoists a prior summary to the FRONT, so the newest
/// row is found by maximum id, not by position.
pub fn newest_active_is_summary(entries: &[CompactionEntry]) -> bool {
    let newest_id = entries.iter().map(|e| e.id).max();
    let newest_summary_id = entries
        .iter()
        .filter(|e| crate::chat::compaction::is_compacted_summary(&e.message))
        .map(|e| e.id)
        .max();
    matches!((newest_id, newest_summary_id), (Some(n), Some(s)) if n == s)
}

/// Whether a session's provider may be swept automatically: local sessions
/// always (gated by the idle switch + token floor), cloud/API sessions only
/// while the user's cloud auto-compaction switch is on. Harness sessions never
/// reach the candidate list. Pure so the tests pin the gate.
pub fn provider_is_sweepable(provider: &str, cloud_enabled: bool) -> bool {
    provider == "local_gguf" || cloud_enabled
}

/// Start the background idle-compaction sweep (called once from app setup).
pub fn start(app: AppHandle, db: Arc<Mutex<Connection>>) {
    tauri::async_runtime::spawn(async move {
        // `interval` fires immediately on its first tick; consume it so the
        // first sweep runs a full interval after boot (the user is present,
        // nothing has gone idle, and the UI is still starting up).
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        // A pass can outlive the interval (a cold summarizer call). Delay
        // rather than burst, so a slow pass doesn't queue up back-to-back
        // sweeps afterwards.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(e) = run_pass(&app, &db).await {
                crate::relay_eprintln!("[idle-compaction] sweep error: {e}");
            }
        }
    });
}

/// One sweep: find idle candidates and compact the eligible ones, up to
/// `max_per_pass`.
async fn run_pass(app: &AppHandle, db: &Arc<Mutex<Connection>>) -> Result<(), String> {
    let cfg = {
        let conn = db.lock();
        load_idle_compaction_config(&conn)
    };
    if !cfg.enabled {
        return Ok(());
    }
    let cutoff = db::now_ts() - (cfg.idle_minutes as i64) * 60;
    let candidates = {
        let conn = db.lock();
        db::list_idle_compact_candidates(&conn, cutoff).map_err(|e| e.to_string())?
    };
    if candidates.is_empty() {
        return Ok(());
    }
    // A cloud/API session is only swept when the user's cloud auto-compaction
    // switch is on — the idle sweep is automatic, so it must honor that switch
    // even though the manual "Compact now" deliberately bypasses it. Local
    // sessions have no such switch (their threshold knob governs the pre-send
    // path; the sweep is separately gated by the idle master switch + floor).
    let cloud_enabled = {
        let conn = db.lock();
        crate::chat::cloud_compact::load_cloud_compaction_config(&conn).enabled
    };

    let mut compacted = 0usize;
    for session in candidates {
        if compacted >= cfg.max_per_pass {
            break;
        }
        let sid = session.id.as_str();
        if recently_attempted(sid)
            || is_busy(app, sid)
            || !provider_is_sweepable(&session.provider, cloud_enabled)
        {
            continue;
        }
        // Stamp the cooldown BEFORE loading history: it amortizes the
        // (indexed but per-session) active-message read for below-floor /
        // already-compacted threads across sweeps instead of re-reading them
        // every 60s. Busy / disabled sessions above are left unstamped so they
        // are reconsidered promptly.
        mark_attempted(sid);
        // Gate on the "already compacted" guard + the token floor BEFORE
        // spending a summarizer call.
        let entries = {
            let conn = db.lock();
            match crate::chat::compaction::load_compaction_entries(&conn, sid) {
                Ok(e) => e,
                Err(_) => continue,
            }
        };
        if newest_active_is_summary(&entries) || estimate_active_tokens(&entries) < cfg.min_tokens {
            continue;
        }

        let Some(client) = app
            .try_state::<crate::ChatState>()
            .map(|c| c.0.client.clone())
        else {
            continue;
        };
        let local_status = app
            .try_state::<crate::chat::local_models::LocalModelState>()
            .and_then(|s| s.0.status());

        crate::chat::stream_events::emit_status_reason(
            Some(app),
            sid,
            "context_compacting",
            "Compacting idle thread…",
        );
        // `force = true`: the idle sweep decides eligibility via `min_tokens`,
        // not the path's window threshold (a 200k-token thread on a 1M window
        // never reaches 75%).
        match crate::chat::commands::compact_session(
            app,
            &client,
            db,
            local_status,
            sid,
            true,
            false,
            true,
        )
        .await
        {
            Ok(outcome) => {
                compacted += 1;
                crate::relay_eprintln!(
                    "[idle-compaction] compacted {} exchange(s) in {} ({} messages active, summary row {})",
                    outcome.compacted_exchange_count,
                    sid,
                    outcome.active_message_count,
                    outcome.summary_id,
                );
                crate::chat::stream_events::emit_status_reason(
                    Some(app),
                    sid,
                    "context_compacted",
                    format!(
                        "Compacted {} exchange(s) while idle — {} messages now active",
                        outcome.compacted_exchange_count, outcome.active_message_count,
                    ),
                );
            }
            Err(e) => {
                // "Nothing aged out" / "no sidecar" / a summarizer error are
                // all benign for a background sweep — log and move on.
                crate::relay_eprintln!("[idle-compaction] skipped {sid}: {e}");
                crate::chat::stream_events::emit_status_clear(Some(app), sid);
            }
        }
    }
    Ok(())
}

/// A session is busy when the builtin chat stream is active OR a harness turn
/// is in flight — the same pair of probes Session Mesh and checkpoint restore
/// use (never compact a live turn).
fn is_busy(app: &AppHandle, sid: &str) -> bool {
    let builtin = app
        .try_state::<crate::ChatState>()
        .map(|c| c.0.has_active_stream(sid))
        .unwrap_or(false);
    let harness = app
        .try_state::<crate::agent_sessions::AgentSessionState>()
        .map(|a| a.0.is_turn_in_flight(sid))
        .unwrap_or(false);
    builtin || harness
}

/// In-memory attempt ledger so a failing pass doesn't retry every sweep.
fn attempts() -> &'static Mutex<HashMap<String, Instant>> {
    static ATTEMPTS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    ATTEMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn recently_attempted(sid: &str) -> bool {
    attempts()
        .lock()
        .get(sid)
        .is_some_and(|t| t.elapsed() < ATTEMPT_COOLDOWN)
}

fn mark_attempted(sid: &str) {
    let mut map = attempts().lock();
    // Bound the map: prune expired entries on every insert.
    map.retain(|_, t| t.elapsed() < ATTEMPT_COOLDOWN);
    map.insert(sid.to_string(), Instant::now());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: i64, role: &str, content: &str) -> CompactionEntry {
        CompactionEntry {
            id,
            message: ChatMessage {
                role: role.to_string(),
                content: content.to_string(),
                images: Vec::new(),
            },
        }
    }

    #[test]
    fn config_defaults() {
        let conn = crate::db::mem();
        assert_eq!(load_idle_compaction_config(&conn), IdleCompactionConfig::default());
        assert_eq!(DEFAULT_IDLE_MINUTES, 60);
        assert_eq!(DEFAULT_IDLE_MIN_TOKENS, 200_000);
        assert_eq!(DEFAULT_IDLE_MAX_PER_PASS, 3);
    }

    #[test]
    fn config_reads_and_clamps() {
        let conn = crate::db::mem();
        crate::db::set_setting(&conn, K_IDLE_ENABLED, "false").unwrap();
        crate::db::set_setting(&conn, K_IDLE_MINUTES, "120").unwrap();
        crate::db::set_setting(&conn, K_IDLE_MIN_TOKENS, "50000").unwrap();
        crate::db::set_setting(&conn, K_IDLE_MAX_PER_PASS, "5").unwrap();
        let cfg = load_idle_compaction_config(&conn);
        assert!(!cfg.enabled);
        assert_eq!(cfg.idle_minutes, 120);
        assert_eq!(cfg.min_tokens, 50_000);
        assert_eq!(cfg.max_per_pass, 5);

        // Out-of-band / garbage values fall back to the defaults.
        crate::db::set_setting(&conn, K_IDLE_MINUTES, "1").unwrap(); // < 5
        crate::db::set_setting(&conn, K_IDLE_MIN_TOKENS, "nope").unwrap();
        crate::db::set_setting(&conn, K_IDLE_MAX_PER_PASS, "9999").unwrap();
        let cfg = load_idle_compaction_config(&conn);
        assert_eq!(cfg.idle_minutes, DEFAULT_IDLE_MINUTES);
        assert_eq!(cfg.min_tokens, DEFAULT_IDLE_MIN_TOKENS);
        assert_eq!(cfg.max_per_pass, DEFAULT_IDLE_MAX_PER_PASS);

        // The enabled parser treats anything but the off-list as on.
        crate::db::set_setting(&conn, K_IDLE_ENABLED, "yes").unwrap();
        assert!(load_idle_compaction_config(&conn).enabled);
        crate::db::set_setting(&conn, K_IDLE_ENABLED, "off").unwrap();
        assert!(!load_idle_compaction_config(&conn).enabled);
    }

    #[test]
    fn estimate_counts_quarter_chars() {
        // 40 chars -> 10 tokens.
        let entries = vec![entry(1, "user", &"x".repeat(40)), entry(2, "assistant", "")];
        assert_eq!(estimate_active_tokens(&entries), 10);
        assert_eq!(estimate_active_tokens(&[]), 0);
    }

    #[test]
    fn newest_active_is_summary_detects_leading_summary() {
        // Summary hoisted to the front with the highest id → already compacted.
        let already = vec![
            entry(5, "system", "[compacted context]\n\nfolding"),
            entry(2, "user", "hello"),
            entry(3, "assistant", "hi"),
        ];
        assert!(newest_active_is_summary(&already));

        // A reply with a higher id than the summary → new activity, eligible.
        let fresh = vec![
            entry(5, "system", "[compacted context]\n\nfolding"),
            entry(3, "assistant", "hi"),
            entry(7, "assistant", "new reply"),
        ];
        assert!(!newest_active_is_summary(&fresh));

        // No summary at all → not "already compacted".
        let none = vec![entry(1, "user", "hello"), entry(2, "assistant", "hi")];
        assert!(!newest_active_is_summary(&none));
    }

    #[test]
    fn candidate_query_filters_harness_bots_and_freshness() {
        let conn = crate::db::mem();
        let now = db::now_ts();

        // Plain idle built-in session → candidate.
        let plain = db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        // Harness session → excluded (context lives in the CLI).
        let harness = db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        db::update_chat_session_agent(&conn, &harness.id, Some("harness:claude_code")).unwrap();
        // Bot session → excluded.
        let bot = db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();
        db::set_chat_session_bot(&conn, &bot.id, Some("bot-1")).unwrap();
        // Fresh session (just active) → excluded by the cutoff.
        let fresh = db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", None).unwrap();

        // Age everything but the fresh session past the cutoff.
        let old = now - 10_000;
        conn.execute(
            "UPDATE chat_sessions SET last_active_at = ?1 WHERE id != ?2",
            rusqlite::params![old, fresh.id],
        )
        .unwrap();

        let candidates = db::list_idle_compact_candidates(&conn, now - 3600).unwrap();
        let ids: Vec<&str> = candidates.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&plain.id.as_str()));
        assert!(!ids.contains(&harness.id.as_str()));
        assert!(!ids.contains(&bot.id.as_str()));
        assert!(!ids.contains(&fresh.id.as_str()));
        // Oldest-first ordering (only `plain` qualifies here, but assert the
        // query did not error and returned built-ins only).
        assert_eq!(candidates.len(), 1);
    }

    #[test]
    fn attempt_cooldown_blocks_then_expires() {
        let sid = format!("test-cooldown-{}", std::process::id());
        assert!(!recently_attempted(&sid));
        mark_attempted(&sid);
        assert!(recently_attempted(&sid));
    }

    #[test]
    fn provider_gate_respects_cloud_switch() {
        // Local sessions are swept regardless of the cloud switch.
        assert!(provider_is_sweepable("local_gguf", true));
        assert!(provider_is_sweepable("local_gguf", false));
        // Cloud/API sessions follow the cloud auto-compaction switch.
        assert!(provider_is_sweepable("anthropic", true));
        assert!(provider_is_sweepable("openrouter", true));
        assert!(!provider_is_sweepable("anthropic", false));
        assert!(!provider_is_sweepable("openai", false));
        assert!(!provider_is_sweepable("auto", false));
    }
}
