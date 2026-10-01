//! `automation_templates` — packaged automation presets (§4.2.7).
//!
//! The parts (cron triggers, full-auto headless runs, GitHub review via the
//! `gh` CLI) have all existed for a while; what was missing is the packaged
//! experience — the "PR review bot" pattern competitors ship as a one-click
//! product. A template is a curated `AutomationInput` prefill: the UI opens
//! the standard Automations form with name/prompt/schedule/agent filled in,
//! the user picks the project (cwd) and confirms, and creation goes through
//! the exact same validated `create_automation` path as a hand-typed row —
//! no parallel write path, no privileged fields.

/// One packaged automation preset the Automations UI offers as a starting
/// point. `prompt` is the EXACT run prompt stored on the automation (the
/// runner appends unattended-run rules at execution time — templates don't).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTemplate {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// The agent id for the form's picker (same ids `ALLOWED_AGENTS` accepts).
    pub harness: &'static str,
    pub model: Option<&'static str>,
    /// 5-field cron, local time — the form's schedule prefills from this.
    pub schedule: &'static str,
    /// The full run prompt stored on the created automation.
    pub prompt: &'static str,
}

/// The packaged templates. Order is display order.
pub fn templates() -> Vec<AutomationTemplate> {
    vec![
        AutomationTemplate {
            id: "pr-review-bot",
            name: "PR review bot",
            description: "Reviews this repo's open pull requests on a schedule \
                and posts concise review comments via the gh CLI (the Bugbot \
                pattern, local and unattended).",
            harness: "claude_code",
            model: None,
            schedule: "0 9 * * 1-5",
            prompt: REVIEW_BOT_PROMPT,
        },
        AutomationTemplate {
            id: "repo-morning-digest",
            name: "Repo morning digest",
            description: "Every weekday morning: what happened on this repo \
                overnight — commits, open PRs, failing checks — summarized \
                into the automation's chat session.",
            harness: "claude_code",
            model: None,
            schedule: "0 8 * * 1-5",
            prompt: MORNING_DIGEST_PROMPT,
        },
    ]
}

/// The PR review bot run prompt. Deliberately: idempotent (skips PRs it
/// already reviewed via a marker comment), read-only on the repo (never
/// pushes/merges), and degrades to an explanation when `gh` is missing or
/// unauthenticated instead of retry-looping.
const REVIEW_BOT_PROMPT: &str = r#"Review the open pull requests in this repository.

1. Enumerate: `gh pr list --state open --limit 20`. If `gh` is missing or not
   authenticated, end the run with a one-line explanation — do not retry.
2. For each open PR: read `gh pr view <number>` and `gh pr diff <number>`.
   Check `gh pr view <number> --comments` for a comment beginning with
   "[relay-review]" — if one exists, skip the PR (already reviewed).
3. Review the diff for correctness bugs, security issues, and missing tests.
   Skip pure-rename/formatting churn with no findings.
4. Post findings: `gh pr review <number> --comment --body "<review>"` where
   <review> starts with "[relay-review]" on its first line, then a one-paragraph
   summary and a bulleted list of concrete findings, each with a file/line
   reference. If the PR looks correct, still post the "[relay-review]" comment
   saying so (do NOT approve — approval is the maintainer's call).
5. Never push, merge, close, or modify any branch. Comments only.

Finish with a short run summary: PRs reviewed, PRs skipped (already reviewed),
findings per PR, anything that failed."#;

/// The morning digest run prompt.
const MORNING_DIGEST_PROMPT: &str = r#"Summarize the last 24 hours of activity in this repository.

1. Confirm `git log --oneline --since="24 hours ago"` works in this directory;
   if not a git repo, end the run with a one-line explanation — do not retry.
2. Collect: recent commits (`git log`), open PRs and their states (`gh pr list
   --state open` when `gh` is available — skip silently if it is not), and the
   current branch/behind-ahead state (`git status -sb`).
3. Write a short digest into your final answer: HEADLINE (one line: is the repo
   quiet or busy, ahead/behind), COMMITS (grouped by theme, most important
   first), OPEN PRS (number, title, state, anything waiting on someone), and
   FLAGS (failing things, stale branches, anything that needs a human).
Keep it under 300 words. Plain text, no markdown tables."#;

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point of "packaged": clicking the template must produce a
    /// row the normal creation path accepts — every template input must pass
    /// the same validation the form's own payload goes through.
    #[test]
    fn every_template_passes_automation_input_validation() {
        let conn = crate::db::mem();
        for t in templates() {
            let mut input = crate::db::automations::AutomationInput {
                name: t.name.to_string(),
                prompt: t.prompt.to_string(),
                harness: t.harness.to_string(),
                model: t.model.map(str::to_string),
                cwd: None,
                schedule: t.schedule.to_string(),
                enabled: Some(true),
                origin: Some("user".to_string()),
                trigger_type: Some("cron".to_string()),
                trigger_config: None,
            };
            crate::commands::automation_cmds::validate_input(&conn, &mut input, None)
                .unwrap_or_else(|e| panic!("template {} rejected: {e}", t.id));
            assert!(
                input.prompt.contains(t.prompt.split('\n').next().unwrap()),
                "validation must keep the template prompt intact"
            );
        }
    }

    /// Live create: a template hand-off must produce a real, enabled row via
    /// the same db write the form uses (no template-specific path).
    #[test]
    fn template_round_trips_through_create_automation() {
        let conn = crate::db::mem();
        let t = &templates()[0];
        let mut input = crate::db::automations::AutomationInput {
            name: t.name.to_string(),
            prompt: t.prompt.to_string(),
            harness: t.harness.to_string(),
            model: None,
            cwd: None,
            schedule: t.schedule.to_string(),
            enabled: Some(true),
            origin: Some("user".to_string()),
            trigger_type: Some("cron".to_string()),
            trigger_config: None,
        };
        crate::commands::automation_cmds::validate_input(&conn, &mut input, None).unwrap();
        let row = crate::db::create_automation(&conn, &input).expect("create");
        assert_eq!(row.name, "PR review bot");
        assert!(row.enabled);
        assert_eq!(row.schedule, "0 9 * * 1-5");
        assert!(row.prompt.contains("[relay-review]"));
    }

    /// The review bot must be idempotent (marker-comment skip) and
    /// non-destructive (no push/merge) by construction of its prompt.
    #[test]
    fn review_bot_prompt_is_idempotent_and_non_destructive() {
        let t = templates()
            .into_iter()
            .find(|t| t.id == "pr-review-bot")
            .expect("pr-review-bot template");
        assert!(t.prompt.contains("[relay-review]"), "marker for skip-on-rerun");
        assert!(t.prompt.contains("already reviewed"), "explicit skip rule");
        assert!(t.prompt.contains("Never push, merge"), "no repo mutation");
        assert!(t.prompt.contains("do not retry"), "unattended runs must fail fast");
    }
}
