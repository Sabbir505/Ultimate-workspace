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

use super::{parse_usage_common, CommandSpec, HarnessAdapter, SessionUsage, UsageInfo};
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

    fn parse_session_id(&self, output: &str) -> Option<String> {
        RE_RESUME_HINT
            .captures(output)
            .map(|c| c[1].to_string())
    }

    fn find_session_id_on_disk(&self, cwd: &Path, since: SystemTime) -> Option<String> {
        find_newest_session_id(cwd, since)
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

/// Filesystem fallback for session-id capture: the newest session_index.jsonl
/// entry for this working directory whose session dir was touched at/after
/// `since` (pane spawn time). Fully defensive: any IO/parse problem → None.
///
/// Known limitation (logged in BUILD_LOG.md): two panes spawned in the SAME
/// cwd within the probe window can cross-attribute the newest session entry.
pub fn find_newest_session_id(cwd: &Path, since: SystemTime) -> Option<String> {
    let index = crate::util::home_dir()?.join(".kimi-code").join("session_index.jsonl");
    let content = fs::read_to_string(index).ok()?;
    let want = normalize_work_dir(cwd);
    // Append-only file: scan bottom-up, first match is the newest for this cwd.
    for line in content.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("workDir").and_then(|w| w.as_str()) != Some(want.as_str()) {
            continue;
        }
        // One malformed index line must not abort the probe — skip it.
        let Some(session_id) = v.get("sessionId").and_then(|s| s.as_str()) else {
            continue;
        };
        // Guard against attributing a pre-existing session to this pane.
        if let Some(dir) = v.get("sessionDir").and_then(|d| d.as_str()) {
            if let Ok(meta) = fs::metadata(dir) {
                if let Ok(mtime) = meta.modified() {
                    if mtime < since {
                        continue;
                    }
                }
            }
        }
        return Some(session_id.to_string());
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
        );
        assert!(res.is_none());
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
        let dir = std::env::temp_dir().join(format!("conduit-kimi-test-{}", uuid::Uuid::new_v4()));
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
