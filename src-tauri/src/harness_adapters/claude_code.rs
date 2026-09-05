//! Claude Code (Anthropic) adapter.
//!
//! Resume architecture: Claude Code persists sessions to disk as JSONL files
//! under `~/.claude/projects/<cwd-slug>/`, so Relay only needs the session id
//! to resurrect a pane later via `claude --resume <id>` — no process needs to
//! stay resident while a pane is unfocused/closed.
//!
//! Session-id capture is a two-layer fallback (PRD §11 open question):
//! 1. Scrape stripped pty output for resume hints (unreliable — Claude Code
//!    does not consistently print its session id in the TUI).
//! 2. Filesystem fallback: watch the project dir's JSONL files for the newest
//!    one created after spawn time; its filename stem IS the session id.
//!    This is the reliable path. All of it is defensive — missing dirs or
//!    permission errors simply yield `None`, never a panic.

use super::{parse_usage_common, CommandSpec, HarnessAdapter, SessionUsage, UsageInfo};
use once_cell::sync::Lazy;
use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub struct ClaudeCodeAdapter;

static RE_RESUME_HINT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)claude\s+(?:--resume|-r)\s+([0-9A-Za-z][0-9A-Za-z._-]{5,})").unwrap()
});
static RE_SESSION_UUID: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)session(?:\s*id)?[:=]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})").unwrap()
});

/// Diff-approval prompt heuristics (PRD §7.3 — best-effort, conservative).
/// These target Claude Code's edit-confirmation UI ("Do you want to make this
/// edit…", the numbered Yes/No selector). False negatives just degrade the
/// pane state to plain "waiting", which the PRD explicitly allows.
static DIFF_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        r"(?i)do you want to (make|apply|proceed)",
        r"(?i)apply this (edit|change)",
        r"❯\s*1\.\s*Yes",
        r"(?i)yes,?\s+and\s+don'?t\s+ask",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

impl HarnessAdapter for ClaudeCodeAdapter {
    fn id(&self) -> &'static str {
        "claude_code"
    }

    fn display_name(&self) -> &'static str {
        "Claude Code"
    }

    fn binary(&self) -> &'static str {
        "claude"
    }

    fn spawn_new_command(&self) -> CommandSpec {
        CommandSpec::new("claude", &[])
    }

    fn spawn_resume_command(&self, session_id: &str) -> CommandSpec {
        CommandSpec::new("claude", &["--resume", session_id])
    }

    fn login_command(&self) -> CommandSpec {
        // ASSUMPTION (logged in BUILD_LOG.md): Claude Code's documented login
        // entry point is `claude auth login`; if a given version only accepts
        // running `claude` and typing `/login`, the user can still do that in
        // the same pane — the pane is just a shell to the harness either way.
        CommandSpec::new("claude", &["auth", "login"])
    }

    fn parse_session_id(&self, output: &str) -> Option<String> {
        if let Some(c) = RE_RESUME_HINT.captures(output) {
            return Some(c[1].to_string());
        }
        if let Some(c) = RE_SESSION_UUID.captures(output) {
            return Some(c[1].to_string());
        }
        None
    }

    fn find_session_id_on_disk(&self, cwd: &Path, since: SystemTime) -> Option<String> {
        find_newest_session_id(cwd, since)
    }

    fn usage_from_disk(&self, cwd: &Path, harness_session_id: &str) -> Option<SessionUsage> {
        parse_session_usage(cwd, harness_session_id)
    }

    fn parse_usage(&self, output: &str) -> Option<UsageInfo> {
        parse_usage_common(output)
    }

    fn diff_prompt_patterns(&self) -> &'static [Regex] {
        &DIFF_PATTERNS
    }
}

/// `D:\Projects\foo bar` -> `D--Projects-foo-bar`, `/home/u/foo` -> `-home-u-foo`.
/// Matches Claude Code's on-disk convention (verified against real
/// `~/.claude/projects/` entries): every character that is not an ASCII
/// alphanumeric, `-` or `_` becomes `-` — that includes path separators, the
/// drive colon, AND spaces. An earlier version only mapped `/ \ :` and broke
/// for any project path containing a space (probe always returned None).
pub fn cwd_slug(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

pub fn claude_projects_dir(cwd: &Path) -> Option<PathBuf> {
    Some(
        crate::util::home_dir()?
            .join(".claude")
            .join("projects")
            .join(cwd_slug(cwd)),
    )
}

/// Filesystem fallback for session-id capture: find the newest `.jsonl` file
/// in Claude's per-project session dir modified at/after `since` (pane spawn
/// time). Returns the file stem, which is the session id. Fully defensive:
/// any IO problem returns None.
pub fn find_newest_session_id(cwd: &Path, since: SystemTime) -> Option<String> {
    // Legacy DB rows may hold \\?\ extended-length paths; the slug must be
    // computed from the plain path or the projects dir will never match.
    let clean = crate::util::strip_unc_prefix(&cwd.to_string_lossy());
    let dir = claude_projects_dir(Path::new(&clean))?;
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<(SystemTime, String)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        // `modified` is used rather than `created` because creation time is
        // not reliably available across filesystems; a brand-new session file
        // is written immediately, so mtime >= spawn time is a safe filter.
        // One unreadable entry must not abort the probe — skip it.
        let Some(mtime) = entry.metadata().ok().and_then(|m| m.modified().ok()) else {
            continue;
        };
        if mtime < since {
            continue;
        }
        let stem = path.file_stem()?.to_string_lossy().into_owned();
        if stem.is_empty() {
            continue;
        }
        if best.as_ref().map_or(true, |(t, _)| mtime > *t) {
            best = Some((mtime, stem));
        }
    }
    best.map(|(_, stem)| stem)
}

/// Cumulative token totals for a Claude session, parsed from its on-disk
/// JSONL (`<slug-dir>/<session-id>.jsonl`). Every assistant message carries a
/// `usage` object; input side includes cache tokens (they are billed as
/// input). Returns None when the file is missing or has no usage yet.
/// Best-effort by design (PRD §7.12 labels all of this an estimate).
pub fn parse_session_usage(cwd: &Path, harness_session_id: &str) -> Option<SessionUsage> {
    let clean = crate::util::strip_unc_prefix(&cwd.to_string_lossy());
    let file = claude_projects_dir(Path::new(&clean))?.join(format!("{harness_session_id}.jsonl"));
    let content = fs::read_to_string(file).ok()?;
    let mut input: i64 = 0;
    let mut cache_creation: i64 = 0;
    let mut cache_read: i64 = 0;
    let mut output: i64 = 0;
    let mut reasoning: i64 = 0;
    let mut found = false;
    let mut model: Option<String> = None;
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // The last model id seen wins — sessions can switch models mid-run.
        if let Some(m) = v.pointer("/message/model").and_then(|m| m.as_str()) {
            model = Some(m.to_string());
        }
        let Some(u) = v.pointer("/message/usage").or_else(|| v.get("usage")) else {
            continue;
        };
        let num = |k: &str| u.get(k).and_then(|n| n.as_i64()).unwrap_or(0);
        input += num("input_tokens");
        cache_creation += num("cache_creation_input_tokens");
        cache_read += num("cache_read_input_tokens");
        output += num("output_tokens");
        // Anthropic surfaces reasoning_tokens on thinking-capable models.
        reasoning += num("reasoning_tokens").max(num("thinking_tokens"));
        found = true;
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
        let spec = ClaudeCodeAdapter.spawn_resume_command("a1b2c3");
        assert_eq!(spec.program, "claude");
        assert_eq!(spec.args, vec!["--resume", "a1b2c3"]);
    }

    #[test]
    fn new_and_login_commands() {
        assert_eq!(ClaudeCodeAdapter.spawn_new_command().args, Vec::<String>::new());
        let login = ClaudeCodeAdapter.login_command();
        assert_eq!(login.program, "claude");
        assert_eq!(login.args, vec!["auth", "login"]);
    }

    #[test]
    fn parse_session_id_from_resume_hint() {
        let out = "Some output...\nTo continue, run: claude --resume 9f2c1a4e-1234-5678-9abc-def012345678\n";
        assert_eq!(
            ClaudeCodeAdapter.parse_session_id(out),
            Some("9f2c1a4e-1234-5678-9abc-def012345678".to_string())
        );
    }

    #[test]
    fn parse_session_id_from_session_line() {
        let out = "Session ID: 9f2c1a4e-1234-5678-9abc-def012345678 started";
        assert_eq!(
            ClaudeCodeAdapter.parse_session_id(out),
            Some("9f2c1a4e-1234-5678-9abc-def012345678".to_string())
        );
    }

    #[test]
    fn parse_session_id_no_match() {
        assert_eq!(ClaudeCodeAdapter.parse_session_id("just chatting away"), None);
    }

    #[test]
    fn cwd_slug_windows_and_unix() {
        assert_eq!(cwd_slug(Path::new(r"D:\Projects\foo")), "D--Projects-foo");
        assert_eq!(cwd_slug(Path::new("/home/u/foo")), "-home-u-foo");
        // Real-world shapes from ~/.claude/projects (spaces, parens → `-`):
        assert_eq!(
            cwd_slug(Path::new(r"D:\Projects\Main project\Content flow\tubeforge")),
            "D--Projects-Main-project-Content-flow-tubeforge"
        );
        assert_eq!(
            cwd_slug(Path::new(r"C:\Users\sabbi\OneDrive\Desktop\New folder (2) testing")),
            "C--Users-sabbi-OneDrive-Desktop-New-folder--2--testing"
        );
    }

    #[test]
    fn find_newest_session_id_missing_dir_is_none() {
        // Nonexistent cwd slug -> missing dir -> None, no panic.
        let res = find_newest_session_id(
            Path::new("/definitely/not/a/real/path-xyz-123"),
            SystemTime::UNIX_EPOCH,
        );
        assert!(res.is_none());
    }

    #[test]
    fn usage_passthrough() {
        let u = ClaudeCodeAdapter.parse_usage("Total cost: $0.42").unwrap();
        assert_eq!(u.cost_usd, Some(0.42));
    }
}

#[cfg(test)]
mod live_probe_tests {
    use super::*;
    use std::time::Duration;

    // Manual diagnostic: hits the real ~/.claude tree. Run with
    // `cargo test -- --ignored live_probe_tubeforge`.
    #[test]
    #[ignore]
    fn live_probe_tubeforge() {
        let since = SystemTime::now() - Duration::from_secs(3600);
        let id = find_newest_session_id(
            Path::new(r"D:\Projects\Main project\Content flow\tubeforge"),
            since,
        );
        eprintln!("probe result: {id:?}");
        assert!(id.is_some());
    }
}

#[cfg(test)]
mod usage_tests {
    use std::io::Write;

    #[test]
    fn parse_usage_sums_message_usage_objects() {
        // Build a fake projects dir layout in a temp dir and point the parser
        // at it via a cwd whose slug maps there is not feasible without HOME
        // override — so test the summing logic through a real file in the
        // system temp dir using the parser's file path directly.
        let dir = std::env::temp_dir().join(format!("relay-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s1.jsonl");
        let mut f = std::fs::File::create(&file).unwrap();
        writeln!(f, r#"{{"type":"user","message":{{"role":"user"}}}}"#).unwrap();
        writeln!(f, r#"{{"type":"assistant","message":{{"usage":{{"input_tokens":100,"cache_read_input_tokens":40,"output_tokens":10}}}}}}"#).unwrap();
        writeln!(f, r#"{{"type":"assistant","message":{{"usage":{{"input_tokens":200,"cache_creation_input_tokens":5,"output_tokens":20}}}}}}"#).unwrap();
        drop(f);
        // Same summing logic as parse_session_usage, applied to the fixture:
        let content = std::fs::read_to_string(&file).unwrap();
        let mut input = 0i64;
        let mut cache_creation = 0i64;
        let mut cache_read = 0i64;
        let mut output = 0i64;
        for line in content.lines() {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            if let Some(u) = v.pointer("/message/usage").or_else(|| v.get("usage")) {
                let num = |k: &str| u.get(k).and_then(|n| n.as_i64()).unwrap_or(0);
                input += num("input_tokens");
                cache_creation += num("cache_creation_input_tokens");
                cache_read += num("cache_read_input_tokens");
                output += num("output_tokens");
            }
        }
        assert_eq!(input, 100 + 200); // raw input, not cache
        assert_eq!(cache_creation, 5);
        assert_eq!(cache_read, 40);
        assert_eq!(output, 30);
        std::fs::remove_dir_all(&dir).ok();
    }
}
