//! CommandCode (commandcode.ai, npm `command-code`) adapter.
//!
//! Resume architecture: CommandCode keeps session transcripts on disk and
//! resumes one directly via `--resume <id>` ("Resume a session by id or
//! name", verified against the official CLI reference). `--session` also
//! accepts a unique id prefix; `-c` continues the newest session in the cwd.
//! The npm package publishes several bin aliases (`cmd`, `cmdc` on Windows,
//! `command-code`, `commandcode`) — we standardize on `commandcode`, the
//! unambiguous name that matches this harness id and works on every platform
//! (`cmd` collides with Windows' own cmd.exe). Session-id capture is
//! output-regex only and the filesystem probe returns None (the
//! conservative-adapter contract: a missed capture degrades resume-by-ID but
//! never breaks the pane).
//!
//! Usage/cost: no per-session cost log we can rely on across versions, so
//! usage_from_disk returns None and pty-scraping via the shared parser is the
//! fallback. Auth is `commandcode login` (a real subcommand, unlike pi/omp).

use super::{parse_usage_common, CommandSpec, HarnessAdapter, UsageInfo};
use once_cell::sync::Lazy;
use regex::Regex;
use std::path::Path;
use std::time::SystemTime;

pub struct CommandCodeAdapter;

/// CommandCode prints session ids in resume hints and session info lines.
/// Its ids are ULID-style (the docs' example is `cmd --session 01hx…`), not
/// UUIDs — so the capture charset is alphanumeric, anchored on the keyword to
/// avoid grabbing arbitrary tokens from tool output.
static RE_SESSION_ID: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)(?:commandcode\s+(?:-r|--resume|--session)\s+|(?:session(?:\s+id)?|resume(?:\s+with)?)\s*[:#]\s*)([0-9a-zA-Z][0-9a-zA-Z_-]{7,})",
    )
    .unwrap()
});

/// Diff-approval prompt heuristics (PRD §7.3 — best-effort, conservative).
/// CommandCode asks yes/no before applying edits; these catch the common
/// shapes. (`--yolo` skips the prompts entirely, but interactive panes keep
/// the CLI's own approval flow in charge.)
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

impl HarnessAdapter for CommandCodeAdapter {
    fn id(&self) -> &'static str {
        "commandcode"
    }

    fn display_name(&self) -> &'static str {
        "CommandCode"
    }

    fn binary(&self) -> &'static str {
        "commandcode"
    }

    fn spawn_new_command(&self) -> CommandSpec {
        CommandSpec::new("commandcode", &[])
    }

    fn spawn_resume_command(&self, session_id: &str) -> CommandSpec {
        // `--resume <id>` — "Resume a session by id or name" (CLI reference).
        CommandSpec::new("commandcode", &["--resume", session_id])
    }

    fn login_command(&self) -> CommandSpec {
        // `login` — "Login with Command Code account" (CLI reference).
        CommandSpec::new("commandcode", &["login"])
    }

    fn parse_session_id(&self, output: &str) -> Option<String> {
        RE_SESSION_ID
            .captures(output)
            .map(|c| c[1].to_string())
    }

    /// No filesystem probe: the transcript store layout is not a documented
    /// interface.
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
        // `commandcode --resume <id>` — verified against the CLI reference.
        let spec = CommandCodeAdapter.spawn_resume_command("01hxsample");
        assert_eq!(spec.program, "commandcode");
        assert_eq!(spec.args, vec!["--resume", "01hxsample"]);
    }

    #[test]
    fn new_command_has_no_args() {
        assert_eq!(CommandCodeAdapter.spawn_new_command().args, Vec::<String>::new());
    }

    #[test]
    fn login_command_is_login() {
        let spec = CommandCodeAdapter.login_command();
        assert_eq!(spec.program, "commandcode");
        assert_eq!(spec.args, vec!["login"]);
    }

    #[test]
    fn parse_session_id_from_hint() {
        let out = "session id: 01HXSAMPLE00000000";
        assert_eq!(
            CommandCodeAdapter.parse_session_id(out),
            Some("01HXSAMPLE00000000".to_string())
        );
    }

    #[test]
    fn parse_session_id_from_resume_hint() {
        let out = "Resuming — commandcode --resume 01hxsample00000";
        assert_eq!(
            CommandCodeAdapter.parse_session_id(out),
            Some("01hxsample00000".to_string())
        );
    }

    #[test]
    fn parse_session_id_no_match() {
        assert_eq!(CommandCodeAdapter.parse_session_id("random terminal text"), None);
        // Must not match the bare launch command or arbitrary tool output.
        assert_eq!(CommandCodeAdapter.parse_session_id("$ commandcode"), None);
        assert_eq!(
            CommandCodeAdapter.parse_session_id("wrote 8f3a1b2c to the cache"),
            None
        );
    }

    #[test]
    fn usage_passthrough() {
        let u = CommandCodeAdapter.parse_usage("Tokens: 1,000 in / 100 out").unwrap();
        assert_eq!(u.input_tokens, Some(1000));
        assert_eq!(u.output_tokens, Some(100));
    }

    #[test]
    fn disk_probe_always_none() {
        assert!(CommandCodeAdapter
            .find_session_id_on_disk(Path::new("/nope"), SystemTime::UNIX_EPOCH)
            .is_none());
    }
}
