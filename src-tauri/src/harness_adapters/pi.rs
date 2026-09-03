//! Pi (earendil-works/pi, npm `@earendil-works/pi-coding-agent`) adapter.
//!
//! Resume architecture: pi keeps session transcripts under `~/.pi/agent/`
//! and resumes one directly via `pi --session <path|id>` — the flag takes a
//! transcript path OR a session id (verified against the CLI's arg parser,
//! `src/cli/args.ts`). `-c` continues the newest session and `-r` opens the
//! interactive picker; neither takes an id, so resume-by-captured-id rides
//! `--session`. There is no stable documented session-log format to probe on
//! disk, so session-id capture is output-regex only and the filesystem probe
//! returns None (the conservative-adapter contract: a missed capture degrades
//! resume-by-ID but never breaks the pane).
//!
//! Usage/cost: pi has no per-session cost log we can rely on across versions,
//! so usage_from_disk returns None and pty-scraping via the shared parser is
//! the fallback. Auth is the in-TUI `/login` slash command (or API-key env
//! vars) — there is no `pi login` subcommand, so login_command just opens
//! the TUI, same approach the Kimi adapter takes.

use super::{parse_usage_common, CommandSpec, HarnessAdapter, UsageInfo};
use once_cell::sync::Lazy;
use regex::Regex;
use std::path::Path;
use std::time::SystemTime;

pub struct PiAdapter;

/// Pi prints its session id in the `/session` info line and echoes
/// `--session <id>` style hints on resume. Anchor on the keyword so a UUID
/// floating in tool output is never captured by mistake.
static RE_SESSION_ID: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)(?:pi\s+--session\s+|(?:session(?:\s+id)?|resume(?:\s+with)?)\s*[:#]\s*)([0-9a-fA-F][0-9a-fA-F-]{7,})",
    )
    .unwrap()
});

/// Diff-approval prompt heuristics (PRD §7.3 — best-effort, conservative).
/// Pi's TUI asks yes/no before applying edits; these catch the common shapes.
static DIFF_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        r"\[(y|Y)/(n|N)\]",
        r"(?i)apply (this |the )?(change|diff|edit)s?\??",
        r"(?i)approve (the |this )?(change|edit|diff)",
        r"(?i)allow (the |this )?(command|tool)",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

impl HarnessAdapter for PiAdapter {
    fn id(&self) -> &'static str {
        "pi"
    }

    fn display_name(&self) -> &'static str {
        "Pi"
    }

    fn binary(&self) -> &'static str {
        "pi"
    }

    fn spawn_new_command(&self) -> CommandSpec {
        CommandSpec::new("pi", &[])
    }

    fn spawn_resume_command(&self, session_id: &str) -> CommandSpec {
        // `--session <path|id>` — verified against src/cli/args.ts: the value
        // is used as-is (path or id both accepted).
        CommandSpec::new("pi", &["--session", session_id])
    }

    fn login_command(&self) -> CommandSpec {
        // Auth lives in the TUI (`/login` for subscription providers, or set
        // an API-key env var). No login subcommand exists — open the TUI.
        CommandSpec::new("pi", &[])
    }

    fn parse_session_id(&self, output: &str) -> Option<String> {
        RE_SESSION_ID
            .captures(output)
            .map(|c| c[1].to_string())
    }

    /// No filesystem probe: the session store layout is not a documented
    /// interface and changed across the mariozechner → earendil-works move.
    fn find_session_id_on_disk(&self, _cwd: &Path, _since: SystemTime) -> Option<String> {
        None
    }

    /// No per-session usage log scrape — pty-scraping is the fallback.
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
        // `pi --session <id>` — verified against the CLI's arg parser.
        let spec = PiAdapter.spawn_resume_command("abc123");
        assert_eq!(spec.program, "pi");
        assert_eq!(spec.args, vec!["--session", "abc123"]);
    }

    #[test]
    fn new_and_login_open_the_tui() {
        assert_eq!(PiAdapter.spawn_new_command().args, Vec::<String>::new());
        // Login has no subcommand — it's the in-TUI /login flow.
        assert_eq!(PiAdapter.login_command().args, Vec::<String>::new());
    }

    #[test]
    fn parse_session_id_from_hint() {
        let out = "session id: 0198f6a2-7c1d-7332-9b4e-1d3f5a7b9c1e";
        assert_eq!(
            PiAdapter.parse_session_id(out),
            Some("0198f6a2-7c1d-7332-9b4e-1d3f5a7b9c1e".to_string())
        );
    }

    #[test]
    fn parse_session_id_from_resume_hint() {
        let out = "Resume with: pi --session 0198f6a2-7c1d-7332-9b4e-1d3f5a7b9c1e";
        assert_eq!(
            PiAdapter.parse_session_id(out),
            Some("0198f6a2-7c1d-7332-9b4e-1d3f5a7b9c1e".to_string())
        );
    }

    #[test]
    fn parse_session_id_no_match() {
        assert_eq!(PiAdapter.parse_session_id("random terminal text"), None);
        // Must not match the bare launch command or tool-output UUIDs.
        assert_eq!(PiAdapter.parse_session_id("$ pi"), None);
        assert_eq!(
            PiAdapter.parse_session_id("fetched 0198f6a2-7c1d-7332-9b4e-1d3f5a7b9c1e from api"),
            None
        );
    }

    #[test]
    fn usage_passthrough() {
        let u = PiAdapter.parse_usage("Tokens: 1,000 in / 100 out").unwrap();
        assert_eq!(u.input_tokens, Some(1000));
        assert_eq!(u.output_tokens, Some(100));
    }

    #[test]
    fn disk_probe_always_none() {
        assert!(PiAdapter
            .find_session_id_on_disk(Path::new("/nope"), SystemTime::UNIX_EPOCH)
            .is_none());
    }
}
