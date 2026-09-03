//! Omp (oh-my-pi, npm `@oh-my-pi/pi-coding-agent`) adapter.
//!
//! Resume architecture: omp is a pi fork with a Rust core; it keeps sessions
//! on disk and resumes one directly via `omp --resume <id>` (per the official
//! docs the flag's completions resolve "against your on-disk sessions").
//! `-p` is the one-shot print mode; `omp setup` performs first-run provider/
//! model/auth configuration. Session-id capture is output-regex only and the
//! filesystem probe returns None (the conservative-adapter contract: a missed
//! capture degrades resume-by-ID but never breaks the pane).
//!
//! Usage/cost: no per-session cost log we can rely on across versions, so
//! usage_from_disk returns None and pty-scraping via the shared parser is the
//! fallback. Auth rides the `omp setup` flow (or in-TUI `/login`).

use super::{parse_usage_common, CommandSpec, HarnessAdapter, UsageInfo};
use once_cell::sync::Lazy;
use regex::Regex;
use std::path::Path;
use std::time::SystemTime;

pub struct OmpAdapter;

/// Omp prints session ids in resume hints and session info lines. Anchor on
/// the keyword so a UUID floating in tool output is never captured.
static RE_SESSION_ID: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)(?:omp\s+(?:--resume|--session)\s+|(?:session(?:\s+id)?|resume(?:\s+with)?)\s*[:#]\s*)([0-9a-fA-F][0-9a-fA-F-]{7,})",
    )
    .unwrap()
});

/// Diff-approval prompt heuristics (PRD §7.3 — best-effort, conservative).
/// Omp's TUI asks yes/no before applying edits; these catch the common shapes.
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

impl HarnessAdapter for OmpAdapter {
    fn id(&self) -> &'static str {
        "omp"
    }

    fn display_name(&self) -> &'static str {
        "Omp"
    }

    fn binary(&self) -> &'static str {
        "omp"
    }

    fn spawn_new_command(&self) -> CommandSpec {
        CommandSpec::new("omp", &[])
    }

    fn spawn_resume_command(&self, session_id: &str) -> CommandSpec {
        // `omp --resume <id>` — per the official quickstart docs.
        CommandSpec::new("omp", &["--resume", session_id])
    }

    fn login_command(&self) -> CommandSpec {
        // `omp setup` performs first-run provider/model/auth configuration;
        // credential switching afterwards is the in-TUI `/login`.
        CommandSpec::new("omp", &["setup"])
    }

    fn parse_session_id(&self, output: &str) -> Option<String> {
        RE_SESSION_ID
            .captures(output)
            .map(|c| c[1].to_string())
    }

    /// No filesystem probe: the session store layout is not a documented
    /// interface (config lives under `~/.omp/agent/`, sessions "on disk").
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
        // `omp --resume <id>` — verified against the official docs.
        let spec = OmpAdapter.spawn_resume_command("abc123");
        assert_eq!(spec.program, "omp");
        assert_eq!(spec.args, vec!["--resume", "abc123"]);
    }

    #[test]
    fn new_command_has_no_args() {
        assert_eq!(OmpAdapter.spawn_new_command().args, Vec::<String>::new());
    }

    #[test]
    fn login_command_is_setup() {
        let spec = OmpAdapter.login_command();
        assert_eq!(spec.program, "omp");
        assert_eq!(spec.args, vec!["setup"]);
    }

    #[test]
    fn parse_session_id_from_hint() {
        let out = "session id: 0198f6a2-7c1d-7332-9b4e-1d3f5a7b9c1e";
        assert_eq!(
            OmpAdapter.parse_session_id(out),
            Some("0198f6a2-7c1d-7332-9b4e-1d3f5a7b9c1e".to_string())
        );
    }

    #[test]
    fn parse_session_id_from_resume_hint() {
        let out = "Resuming — omp --resume 0198f6a2-7c1d-7332-9b4e-1d3f5a7b9c1e";
        assert_eq!(
            OmpAdapter.parse_session_id(out),
            Some("0198f6a2-7c1d-7332-9b4e-1d3f5a7b9c1e".to_string())
        );
    }

    #[test]
    fn parse_session_id_no_match() {
        assert_eq!(OmpAdapter.parse_session_id("random terminal text"), None);
        // Must not match the bare launch command or tool-output UUIDs.
        assert_eq!(OmpAdapter.parse_session_id("$ omp"), None);
        assert_eq!(
            OmpAdapter.parse_session_id("fetched 0198f6a2-7c1d-7332-9b4e-1d3f5a7b9c1e from api"),
            None
        );
    }

    #[test]
    fn usage_passthrough() {
        let u = OmpAdapter.parse_usage("Tokens: 1,000 in / 100 out").unwrap();
        assert_eq!(u.input_tokens, Some(1000));
        assert_eq!(u.output_tokens, Some(100));
    }

    #[test]
    fn disk_probe_always_none() {
        assert!(OmpAdapter
            .find_session_id_on_disk(Path::new("/nope"), SystemTime::UNIX_EPOCH)
            .is_none());
    }
}
