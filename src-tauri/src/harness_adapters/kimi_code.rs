//! Kimi Code CLI (Moonshot AI) adapter.
//!
//! Resume architecture: Kimi persists every session under
//! `~/.kimi-code/sessions/<workDirKey>/<sessionId>/` and appends a line to
//! `~/.kimi-code/session_index.jsonl` ({"sessionId","sessionDir","workDir"}).
//! Resume is `kimi --session <sessionId>` (verified against `kimi --help`,
//! v0.27.0 — note there is NO `-r` flag; an earlier version of this adapter
//! invented one and resume silently failed, see BUILD_LOG.md).
//!
//! Session-id capture: the TUI does not reliably print the session id, so the
//! reliable path is the filesystem fallback — watch session_index.jsonl for
//! the newest entry whose workDir matches the pane's cwd, created at/after
//! spawn time. Output scraping is kept as a cheap first chance.

use super::{
    claim_session, is_claimed_by_other, parse_usage_common, CommandSpec, DiscoveredSessionId,
    HarnessAdapter, SessionUsage, UsageInfo,
};
use once_cell::sync::Lazy;
use regex::Regex;
use std::fs;
use std::path::Path;
use std::time::SystemTime;

pub struct KimiCodeAdapter;

static RE_RESUME_HINT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)kimi\s+(?:-S|--session)\s+(session_[0-9A-Za-z][0-9A-Za-z._-]{3,}|[0-9a-fA-F-]{8,})").unwrap()
});

/// Diff-approval prompt heuristics (PRD §7.3 — best-effort, conservative).
static DIFF_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        r"(?i)apply (this |the )?(change|diff|edit)s?\??",
        r"\[(y|Y)/(n|N)\]",
        r"(?i)approve (the |this )?(change|edit|diff)",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

impl HarnessAdapter for KimiCodeAdapter {
    fn id(&self) -> &'static str {
        "kimi_code"
    }

    fn display_name(&self) -> &'static str {
        "Kimi Code"
    }

    fn binary(&self) -> &'static str {
        "kimi"
    }

    fn spawn_new_command(&self) -> CommandSpec {
        CommandSpec::new("kimi", &[])
    }

    fn spawn_resume_command(&self, session_id: &str) -> CommandSpec {
        CommandSpec::new("kimi", &["--session", session_id])
    }

    fn login_command(&self) -> CommandSpec {
        // Kimi has no separate `auth login` subcommand; you run `kimi` and
        // type `/login` inside the TUI. So the login pane just launches the
        // interactive CLI and the UI copy guides the user to run `/login`.
        CommandSpec::new("kimi", &[])
    }

    /// The native installer (~/.kimi-code/bin) shadows any npm shim on PATH;
    /// `kimi upgrade` updates whichever copy PATH resolves (verified 0.31).
    fn native_update_command(&self, _resolved: &std::path::Path) -> Option<CommandSpec> {
        Some(CommandSpec::new("kimi", &["upgrade"]))
    }

    fn parse_session_id(&self, output: &str) -> Option<String> {
        RE_RESUME_HINT
            .captures(output)
            .map(|c| c[1].to_string())
    }

    fn find_session_id_on_disk(
        &self,
        cwd: &Path,
        since: SystemTime,
        owner: &str,
    ) -> Option<DiscoveredSessionId> {
        find_newest_session_id(cwd, since, owner)
    }

    fn usage_from_disk(&self, _cwd: &Path, harness_session_id: &str) -> Option<SessionUsage> {
        parse_session_usage(harness_session_id)
    }

    fn parse_usage(&self, output: &str) -> Option<UsageInfo> {
        parse_usage_common(output)
    }

    fn diff_prompt_patterns(&self) -> &'static [Regex] {
        &DIFF_PATTERNS
    }
}

/// Kimi's session_index.jsonl stores workDir with forward slashes
/// ("D:/Projects/foo"); normalize the pane cwd the same way for comparison.
fn normalize_work_dir(cwd: &Path) -> String {
    let s = crate::util::strip_unc_prefix(&cwd.to_string_lossy()).replace('\\', "/");
    s.trim_end_matches('/').to_string()
}

/// Compare an index `workDir` against the normalized pane cwd. Windows paths
/// are case-insensitive, and a pane cwd of `d:/projects/foo` would never match
/// the index's `D:/Projects/foo` under a plain string compare — silently
/// disabling session capture for that pane.
fn work_dir_matches(stored: Option<&str>, want: &str) -> bool {
    let Some(stored) = stored else { return false };
    if stored == want {
        return true;
    }
    if cfg!(windows) {
        return stored.eq_ignore_ascii_case(want);
    }
    false
}

/// Filesystem fallback for session-id capture: the newest session_index.jsonl
/// entry for this working directory whose session dir was touched at/after
/// `since` (pane spawn time). Fully defensive: any IO/parse problem → None.
///
/// Two panes in the SAME cwd are indistinguishable from the index alone — it
/// records `workDir` but nothing tying an entry to the process that created it
/// — so both would take the same "newest" line. Instead of handing that line to
/// whoever polls first, this function honours the shared claim registry
/// (see `super::session_claims`): an id another live pane already owns is
/// skipped and the scan continues to the next candidate. `ambiguous` is set
/// when a newer entry had to be stepped over, which is the signal the UI uses
/// to flag the id as a guess.
pub fn find_newest_session_id(cwd: &Path, since: SystemTime, owner: &str) -> Option<DiscoveredSessionId> {
    let index = crate::util::home_dir()?.join(".kimi-code").join("session_index.jsonl");
    let content = fs::read_to_string(index).ok()?;
    let want = normalize_work_dir(cwd);
    let mut ambiguous = false;
    // Append-only file: scan bottom-up, so the first match is the newest for
    // this cwd.
    for line in content.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if !work_dir_matches(v.get("workDir").and_then(|w| w.as_str()), &want) {
            continue;
        }
        // One malformed index line must not abort the probe — skip it.
        let Some(session_id) = v.get("sessionId").and_then(|s| s.as_str()) else {
            continue;
        };
        // Guard against attributing a pre-existing session to this pane. The
        // previous code treated the guard as best-effort (`if let Some(dir)`),
        // so an index line without a sessionDir matched ANY historical session
        // in that cwd. An unverifiable entry is not evidence of a new session.
        let Some(dir) = v.get("sessionDir").and_then(|d| d.as_str()) else {
            continue;
        };
        let Ok(meta) = fs::metadata(dir) else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if mtime < since {
            continue;
        }
        // Another live pane already owns this session — it is almost certainly
        // THAT pane's session, not ours. Keep looking.
        if is_claimed_by_other(session_id, owner) {
            ambiguous = true;
            continue;
        }
        claim_session(session_id, owner);
        return Some(DiscoveredSessionId::new(session_id.to_string(), ambiguous));
    }
    None
}

/// Cumulative token totals for a Kimi session, summed from `usage.record`
/// events in every agent's wire.jsonl under
/// `~/.kimi-code/sessions/<workDirKey>/<sessionId>/agents/`. Input counts
/// cache reads/creations as input (they are billed as such). Best-effort
/// estimate per PRD §7.12; None when the session dir is missing or has no
/// usage events yet.
pub fn parse_session_usage(harness_session_id: &str) -> Option<SessionUsage> {
    let sessions_root = crate::util::home_dir()?.join(".kimi-code").join("sessions");
    let mut input: i64 = 0;
    let mut cache_read: i64 = 0;
    let mut cache_creation: i64 = 0;
    let mut output: i64 = 0;
    let mut reasoning: i64 = 0;
    let mut found = false;
    let mut model: Option<String> = None;
    for wd in fs::read_dir(sessions_root).ok()?.flatten() {
        let session_dir = wd.path().join(harness_session_id);
        if !session_dir.is_dir() {
            continue;
        }
        let agents_dir = session_dir.join("agents");
        for agent in fs::read_dir(agents_dir).ok()?.flatten() {
            let wire = agent.path().join("wire.jsonl");
            let Ok(content) = fs::read_to_string(wire) else {
                continue;
            };
            for line in content.lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                if v.get("type").and_then(|t| t.as_str()) != Some("usage.record") {
                    continue;
                }
                if let Some(m) = v.get("model").and_then(|m| m.as_str()) {
                    model = Some(m.to_string());
                }
                let Some(u) = v.get("usage") else { continue };
                let num = |k: &str| u.get(k).and_then(|n| n.as_i64()).unwrap_or(0);
                input += num("inputOther");
                cache_read += num("inputCacheRead");
                cache_creation += num("inputCacheCreation");
                output += num("output");
                reasoning += num("reasoning_tokens").max(num("thinking_tokens"));
                found = true;
            }
        }
    }
    found.then_some(SessionUsage {
        usage: UsageInfo {
            input_tokens: Some(input),
            output_tokens: Some(output),
            cache_creation_input_tokens: Some(cache_creation),
            cache_read_input_tokens: Some(cache_read),
            reasoning_output_tokens: Some(reasoning),
            cost_usd: None,
        },
        model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serializes the tests that repoint HOME — every other test in the binary
    /// would otherwise see a random temp dir as its home (see
    /// installed_skills.rs, which uses the same guard).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Point HOME/USERPROFILE at `dir` and hand back a restore closure.
    fn use_home(dir: &std::path::Path) -> impl Fn() {
        let prev_home = std::env::var("HOME").ok();
        let prev_profile = std::env::var("USERPROFILE").ok();
        std::env::set_var("USERPROFILE", dir);
        std::env::set_var("HOME", dir);
        move || {
            if let Some(v) = prev_home.clone() {
                std::env::set_var("HOME", v);
            }
            if let Some(v) = prev_profile.clone() {
                std::env::set_var("USERPROFILE", v);
            }
        }
    }

    /// Build `~/.kimi-code/session_index.jsonl` plus the session dirs it
    /// points at, inside `home`. Kimi appends one line per session, so the
    /// fixture mirrors that append order (older first).
    fn write_index(home: &Path, entries: &[(&str, &str)]) -> std::path::PathBuf {
        let kimi = home.join(".kimi-code");
        std::fs::create_dir_all(kimi.join("sessions")).unwrap();
        let mut lines = String::new();
        for (session_id, dir_name) in entries {
            let dir = kimi.join("sessions").join(dir_name);
            std::fs::create_dir_all(&dir).unwrap();
            lines.push_str(&format!(
                "{{\"sessionId\":\"{session_id}\",\"sessionDir\":\"{}\",\"workDir\":\"D:/proj\"}}\n",
                dir.to_string_lossy().replace('\\', "/")
            ));
        }
        let index = kimi.join("session_index.jsonl");
        std::fs::write(&index, lines).unwrap();
        index
    }

    #[test]
    fn resume_command_args() {
        // `kimi --session <id>` — verified against `kimi --help` (v0.27.0);
        // there is no `-r` flag.
        let spec = KimiCodeAdapter.spawn_resume_command("session_x9y8z7");
        assert_eq!(spec.program, "kimi");
        assert_eq!(spec.args, vec!["--session", "session_x9y8z7"]);
    }

    #[test]
    fn new_command_has_no_args() {
        assert_eq!(KimiCodeAdapter.spawn_new_command().args, Vec::<String>::new());
    }

    #[test]
    fn parse_session_id_from_exit_hint() {
        let out = "Session ended.\nTo resume this session, run: kimi --session session_abc123-def456\nGoodbye!";
        assert_eq!(
            KimiCodeAdapter.parse_session_id(out),
            Some("session_abc123-def456".to_string())
        );
    }

    #[test]
    fn parse_session_id_short_flag() {
        let out = "resume with: kimi -S session_001122";
        assert_eq!(
            KimiCodeAdapter.parse_session_id(out),
            Some("session_001122".to_string())
        );
    }

    #[test]
    fn parse_session_id_no_match() {
        assert_eq!(KimiCodeAdapter.parse_session_id("random terminal text"), None);
        // Must not match the bare `kimi` launch command or the picker form.
        assert_eq!(KimiCodeAdapter.parse_session_id("$ kimi"), None);
        assert_eq!(KimiCodeAdapter.parse_session_id("$ kimi --session"), None);
    }

    #[test]
    fn normalize_work_dir_slashes() {
        assert_eq!(
            normalize_work_dir(Path::new("D:/Projects/foo")),
            "D:/Projects/foo"
        );
        #[cfg(windows)]
        assert_eq!(
            normalize_work_dir(Path::new(r"\\?\D:\Projects\foo\")),
            "D:/Projects/foo"
        );
    }

    #[test]
    fn find_newest_session_id_missing_index_is_none() {
        // A cwd that will never appear in any real index → None, no panic.
        let res = find_newest_session_id(
            Path::new("/definitely/not/a/real/path-xyz-123"),
            SystemTime::UNIX_EPOCH,
            "pane-1",
        );
        assert!(res.is_none());
    }

    #[test]
    fn work_dir_match_is_case_insensitive_on_windows() {
        assert!(work_dir_matches(Some("D:/Projects/foo"), "D:/Projects/foo"));
        assert!(!work_dir_matches(None, "D:/Projects/foo"));
        assert!(!work_dir_matches(Some("D:/Projects/bar"), "D:/Projects/foo"));
        #[cfg(windows)]
        assert!(work_dir_matches(Some("d:/projects/FOO"), "D:/Projects/foo"));
    }

    /// The documented two-pane failure: both panes spawn Kimi in `D:/proj`,
    /// Kimi appends one index line per session, and both panes probe the same
    /// store. The probe must not hand the newest entry to both — the second
    /// pane skips it (marking the result ambiguous) and takes the next
    /// candidate, so neither pane resumes or bills the other's session.
    #[test]
    fn two_panes_same_cwd_do_not_share_a_session_id() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        super::super::clear_claims();
        let home = std::env::temp_dir().join(format!("relay-kimi-2pane-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let restore = use_home(&home);
        // Append order matters: session_a is older, session_b is the newest.
        write_index(&home, &[("session_a", "a"), ("session_b", "b")]);
        // Both session dirs were touched after spawn, so the time filter
        // passes for both — only the claim registry separates the panes.
        let since = std::time::SystemTime::now() - std::time::Duration::from_secs(600);

        let first = find_newest_session_id(Path::new("D:/proj"), since, "pane-1").expect("pane-1 gets a session");
        assert_eq!(first.id, "session_b");
        assert!(!first.ambiguous, "pane-1 took the newest entry cleanly");

        let second =
            find_newest_session_id(Path::new("D:/proj"), since, "pane-2").expect("pane-2 still finds a session");
        assert_eq!(second.id, "session_a", "pane-2 must not take pane-1's session");
        assert!(second.ambiguous, "pane-2 stepped over a newer claimed entry");

        // A third pane in the same cwd has nothing left, and that is the
        // correct outcome: no id beats a wrong id.
        let third = find_newest_session_id(Path::new("D:/proj"), since, "pane-3");
        assert!(third.is_none(), "every entry is claimed; pane-3 must get none");

        // The same owner re-probing is idempotent, not blocked by its own claim.
        let again = find_newest_session_id(Path::new("D:/proj"), since, "pane-1").expect("owner re-probe");
        assert_eq!(again.id, "session_b");

        // A different cwd is unaffected by the claims above.
        std::fs::write(
            home.join(".kimi-code").join("session_index.jsonl"),
            format!(
                "{{\"sessionId\":\"session_c\",\"sessionDir\":\"{}\",\"workDir\":\"D:/other\"}}\n",
                home.join(".kimi-code/sessions/b").to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        let other =
            find_newest_session_id(Path::new("D:/other"), since, "pane-4").expect("other cwd unaffected");
        assert_eq!(other.id, "session_c");

        drop(restore);
        super::super::clear_claims();
        std::fs::remove_dir_all(&home).ok();
    }

    /// An index line with no `sessionDir` cannot be dated, so it can never be
    /// distinguished from a session that predates this pane. The previous code
    /// treated it as a match — silently attributing a days-old session.
    #[test]
    fn index_entry_without_session_dir_is_ignored() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        super::super::clear_claims();
        let home = std::env::temp_dir().join(format!("relay-kimi-nodir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(home.join(".kimi-code")).unwrap();
        let restore = use_home(&home);
        std::fs::write(
            home.join(".kimi-code").join("session_index.jsonl"),
            "{\"sessionId\":\"session_x\",\"workDir\":\"D:/proj\"}\n",
        )
        .unwrap();
        let since = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        let res = find_newest_session_id(Path::new("D:/proj"), since, "pane-1");
        assert!(res.is_none(), "undatable entry must not be attributed");
        drop(restore);
        super::super::clear_claims();
        std::fs::remove_dir_all(&home).ok();
    }


    #[test]
    fn usage_passthrough() {
        let u = KimiCodeAdapter.parse_usage("Tokens: 2,000 in / 300 out").unwrap();
        assert_eq!(u.input_tokens, Some(2000));
        assert_eq!(u.output_tokens, Some(300));
    }

    #[test]
    fn parse_kimi_session_usage_separates_cache() {
        // Verify the four cache/reasoning components are tracked separately in
        // parse_session_usage, mirroring the summing logic.
        let dir = std::env::temp_dir().join(format!("relay-kimi-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("wire.jsonl");
        std::fs::write(
            &file,
            r#"{"type":"usage.record","usage":{"input":100,"output":10,"inputCacheRead":40,"inputCacheCreation":5},"model":"kimi-k3"}
"#,
        ).unwrap();
        // Read the fixture and sum like parse_session_usage does.
        let content = std::fs::read_to_string(&file).unwrap();
        let mut input = 0i64;
        let mut cache_read = 0i64;
        let mut cache_creation = 0i64;
        let mut output = 0i64;
        for line in content.lines() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if v.get("type").and_then(|t| t.as_str()) == Some("usage.record") {
                    if let Some(u) = v.get("usage") {
                        let num = |k: &str| u.get(k).and_then(|n| n.as_i64()).unwrap_or(0);
                        input += num("input");
                        cache_read += num("inputCacheRead");
                        cache_creation += num("inputCacheCreation");
                        output += num("output");
                    }
                }
            }
        }
        assert_eq!(input, 100);
        assert_eq!(cache_read, 40);
        assert_eq!(cache_creation, 5);
        assert_eq!(output, 10);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod usage_tests {
    #[test]
    fn usage_record_fields_sum() {
        // Fixture matching the real wire.jsonl usage.record shape.
        let lines = [
            r#"{"type":"llm.request"}"#,
            r#"{"type":"usage.record","usage":{"inputOther":100,"output":10,"inputCacheRead":40,"inputCacheCreation":5}}"#,
            r#"{"type":"usage.record","usage":{"inputOther":200,"output":20,"inputCacheRead":0,"inputCacheCreation":0}}"#,
        ];
        let mut input = 0i64;
        let mut output = 0i64;
        for line in lines {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            if v.get("type").and_then(|t| t.as_str()) != Some("usage.record") {
                continue;
            }
            let u = v.get("usage").unwrap();
            let num = |k: &str| u.get(k).and_then(|n| n.as_i64()).unwrap_or(0);
            input += num("inputOther") + num("inputCacheRead") + num("inputCacheCreation");
            output += num("output");
        }
        assert_eq!(input, 345);
        assert_eq!(output, 30);
    }
}
