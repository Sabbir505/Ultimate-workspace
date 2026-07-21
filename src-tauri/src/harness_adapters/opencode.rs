//! OpenCode (sst/opencode) adapter.
//!
//! Resume architecture: OpenCode persists sessions in a SQLite database at
//! `~/.local/share/opencode/opencode.db` and resumes via `opencode -s <id>`
//! (alias `--session`); `-c` continues the *last* session. Verified against
//! `opencode --help` (v1.18.3). There is no JSONL session log to watch, so
//! session-id capture is output-regex only — the filesystem probe returns
//! None (querying OpenCode's SQLite DB would risk locking/schema drift and
//! is out of scope for v1). A missed capture degrades resume-by-ID but never
//! breaks the pane — the conservative-adapter contract.
//!
//! Usage/cost: OpenCode has a separate `opencode stats` command (not a per-
//! session log), so usage_from_disk returns None; pty-scraping via the shared
//! parser is the fallback. Auth is `opencode providers` (alias: `auth`).

use super::{parse_usage_common, CommandSpec, HarnessAdapter, UsageInfo};
use once_cell::sync::Lazy;
use regex::Regex;
use std::path::Path;
use std::time::SystemTime;

pub struct OpenCodeAdapter;

/// OpenCode prints session ids as part of its session/resume hints. Match
/// the common shapes:
///   - "Resume with: opencode -s <uuid>"  /  "opencode --session <uuid>"
///   - "session id: <uuid>" / "resume <uuid>" / "continue <uuid>"
/// Conservative — a non-match just means we don't auto-capture for resume.
static RE_SESSION_ID: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        // A UUID (8-4-4-4-12 hex) preceded by a resume hint keyword or the
        // `opencode -s/--session` flag. The keyword/flag anchors it so we don't
        // match arbitrary UUIDs floating in tool output.
        r"(?i)(?:opencode\s+(?:-s|--session)\s+|(?:session(?:\s+id)?|resume(?:\s+with)?|continue)\s*[:#]?\s*)([0-9a-fA-F]{8,}-[0-9a-fA-F]{4,}-[0-9a-fA-F]{4,}-[0-9a-fA-F]{4,}-[0-9a-fA-F]{12})",
    )
    .unwrap()
});

/// Diff-approval prompt heuristics (PRD §7.3 — best-effort, conservative).
/// OpenCode's TUI is a Bubbletea-style interface; these patterns catch the
/// common y/n approval prompts.
static DIFF_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        r"\[(y|Y)/(n|N)\]",
        r"(?i)apply (this |the )?(change|diff|edit)s?\??",
        r"(?i)approve (the |this )?(change|edit|diff)",
        r"(?i)accept (the |this )?(change|edit|diff)",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

impl HarnessAdapter for OpenCodeAdapter {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn display_name(&self) -> &'static str {
        "OpenCode"
    }

    fn binary(&self) -> &'static str {
        "opencode"
    }

    fn spawn_new_command(&self) -> CommandSpec {
        CommandSpec::new("opencode", &[])
    }

    fn spawn_resume_command(&self, session_id: &str) -> CommandSpec {
        // `opencode -s <id>` (alias --session). Verified v1.18.3.
        CommandSpec::new("opencode", &["-s", session_id])
    }

    fn login_command(&self) -> CommandSpec {
        // `opencode providers` (alias: `auth`) manages providers/credentials.
        CommandSpec::new("opencode", &["providers"])
    }

    fn parse_session_id(&self, output: &str) -> Option<String> {
        RE_SESSION_ID
            .captures(output)
            .map(|c| c[1].to_string())
    }

    /// No filesystem probe: OpenCode stores sessions in a SQLite DB, not JSONL.
    /// Querying it risks locking/schema drift and is out of scope for v1.
    fn find_session_id_on_disk(&self, _cwd: &Path, _since: SystemTime) -> Option<String> {
        None
    }

    /// No per-session log scrape: usage comes from `opencode stats` (a separate
    /// command), not a session file. Pty-scraping via parse_usage is the
    /// fallback. Returns None so the monitor loop skips the disk sync.
    fn usage_from_disk(&self, _cwd: &Path, _harness_session_id: &str) -> Option<super::SessionUsage> {
        None
    }

    fn parse_usage(&self, output: &str) -> Option<UsageInfo> {
        parse_usage_common(output)
    }

    fn diff_prompt_patterns(&self) -> &'static [Regex] {
        &DIFF_PATTERNS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_command_args() {
        // `opencode -s <id>` — verified against `opencode --help` (v1.18.3).
        let spec = OpenCodeAdapter.spawn_resume_command("12345678-1234-1234-1234-1234567890ab");
        assert_eq!(spec.program, "opencode");
        assert_eq!(spec.args, vec!["-s", "12345678-1234-1234-1234-1234567890ab"]);
    }

    #[test]
    fn new_command_has_no_args() {
        assert_eq!(OpenCodeAdapter.spawn_new_command().args, Vec::<String>::new());
    }

    #[test]
    fn login_command_is_providers() {
        let spec = OpenCodeAdapter.login_command();
        assert_eq!(spec.program, "opencode");
        assert_eq!(spec.args, vec!["providers"]);
    }

    #[test]
    fn parse_session_id_from_hint() {
        let out = "Session created. Resume with: opencode -s 12345678-1234-1234-1234-1234567890ab";
        assert_eq!(
            OpenCodeAdapter.parse_session_id(out),
            Some("12345678-1234-1234-1234-1234567890ab".to_string())
        );
    }

    #[test]
    fn parse_session_id_labeled() {
        let out = "session id: abcdef12-3456-7890-abcd-ef1234567890";
        assert_eq!(
            OpenCodeAdapter.parse_session_id(out),
            Some("abcdef12-3456-7890-abcd-ef1234567890".to_string())
        );
    }

    #[test]
    fn parse_session_id_no_match() {
        assert_eq!(OpenCodeAdapter.parse_session_id("random terminal text"), None);
        // Must not match the bare launch command.
        assert_eq!(OpenCodeAdapter.parse_session_id("$ opencode"), None);
    }

    #[test]
    fn usage_passthrough() {
        let u = OpenCodeAdapter.parse_usage("Tokens: 1,500 in / 250 out").unwrap();
        assert_eq!(u.input_tokens, Some(1500));
        assert_eq!(u.output_tokens, Some(250));
    }

    #[test]
    fn disk_probe_always_none() {
        assert!(OpenCodeAdapter
            .find_session_id_on_disk(Path::new("/nope"), SystemTime::UNIX_EPOCH)
            .is_none());
    }
}
