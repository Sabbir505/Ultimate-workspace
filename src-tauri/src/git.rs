//! Git integration via shelling out to the `git` binary (PRD §7.10/§7.11).
//!
//! Everything here degrades gracefully: if git isn't installed or the path
//! isn't a repo, callers get `is_repo: false` / an error string — never a
//! panic. The polling-based status approach is deliberate (PRD §7.11): the
//! frontend re-calls `get_git_status` on an interval rather than us running a
//! filesystem watcher.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::types::GitStatusInfo;

const DIFF_CAP_BYTES: usize = 200 * 1024;

fn git_command(cwd: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    // Prevent console-window flashes when the GUI app shells out on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output()
}

/// Ok(stdout trimmed) on success, Err(stderr trimmed or message) otherwise.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_command(cwd, args).map_err(|e| format!("failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Parses the output of `git rev-list --left-right --count @{upstream}...HEAD`,
/// which is "<left>\t<right>": left = commits on the upstream side (we are
/// *behind* by that many), right = commits on our side (we are *ahead*).
/// Returns (ahead, behind).
pub fn parse_ahead_behind(output: &str) -> Option<(i64, i64)> {
    let mut parts = output.split_whitespace();
    let behind: i64 = parts.next()?.parse().ok()?;
    let ahead: i64 = parts.next()?.parse().ok()?;
    Some((ahead, behind))
}

pub fn is_git_repo(path: &Path) -> bool {
    run_git(path, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s == "true")
        .unwrap_or(false)
}

pub fn get_git_status(path: &Path) -> GitStatusInfo {
    let not_repo = GitStatusInfo {
        is_repo: false,
        branch: None,
        dirty: false,
        ahead: 0,
        behind: 0,
    };
    if !path.is_dir() || !is_git_repo(path) {
        return not_repo;
    }
    // Empty on a detached HEAD — reported as None rather than guessing.
    let branch = run_git(path, &["branch", "--show-current"])
        .ok()
        .filter(|b| !b.is_empty());
    let dirty = run_git(path, &["status", "--porcelain"])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    // No upstream configured (very common for local-only branches) — the
    // command fails and we fall back to 0/0 rather than erroring the badge.
    let (ahead, behind) = run_git(path, &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
        .ok()
        .and_then(|s| parse_ahead_behind(&s))
        .unwrap_or((0, 0));
    GitStatusInfo {
        is_repo: true,
        branch,
        dirty,
        ahead,
        behind,
    }
}

/// `<project-parent>/<project-name>-<sanitized-branch>` (CONTRACT.md).
/// Slashes are legal in branch names (`feature/x`) but not in a single
/// directory component, so anything non [A-Za-z0-9._-] becomes `-`.
pub fn worktree_path_for(project_path: &Path, branch_name: &str) -> PathBuf {
    let sanitized: String = branch_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let project_name = project_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".to_string());
    let parent = project_path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{project_name}-{sanitized}"))
}

/// `git worktree add <path> -b <branch>`; returns the new worktree path.
pub fn create_worktree(project_path: &Path, branch_name: &str) -> Result<String, String> {
    if branch_name.trim().is_empty() {
        return Err("branch name must not be empty".into());
    }
    let wt = worktree_path_for(project_path, branch_name);
    let wt_str = wt.to_string_lossy().into_owned();
    run_git(project_path, &["worktree", "add", &wt_str, "-b", branch_name])?;
    Ok(wt_str)
}

/// Unified diff of the working tree against HEAD (staged + unstaged),
/// truncated at ~200KB per CONTRACT.md.
pub fn get_git_diff(path: &Path) -> Result<String, String> {
    let mut diff = run_git(path, &["diff", "HEAD"])?;
    if diff.len() > DIFF_CAP_BYTES {
        // Truncate on a char boundary to keep the string valid UTF-8.
        let mut end = DIFF_CAP_BYTES;
        while !diff.is_char_boundary(end) {
            end -= 1;
        }
        diff.truncate(end);
        diff.push_str("\n... (diff truncated at 200KB)");
    }
    Ok(diff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ahead_behind_basic() {
        // "2\t3" = 2 behind (upstream side), 3 ahead (our side)
        assert_eq!(parse_ahead_behind("2\t3"), Some((3, 2)));
        assert_eq!(parse_ahead_behind("0 0"), Some((0, 0)));
        assert_eq!(parse_ahead_behind(""), None);
        assert_eq!(parse_ahead_behind("garbage"), None);
        assert_eq!(parse_ahead_behind("1"), None);
    }

    #[test]
    fn worktree_path_sanitizes_branch() {
        let p = worktree_path_for(Path::new("/home/u/myproj"), "feature/login-fix");
        assert_eq!(p, PathBuf::from("/home/u/myproj-feature-login-fix"));
    }

    #[test]
    fn worktree_path_plain_branch() {
        let p = worktree_path_for(Path::new("/home/u/myproj"), "main");
        assert_eq!(p, PathBuf::from("/home/u/myproj-main"));
    }

    #[test]
    fn nonexistent_path_is_not_repo() {
        let s = get_git_status(Path::new("/definitely/not/here-xyz-123"));
        assert!(!s.is_repo);
        assert_eq!(s.branch, None);
    }

    /// Mirrors the core of `init_git_repo` (commands::projects): a non-repo
    /// folder, `git init` via the same shelling-out path, then re-check. This
    /// proves the "Initialize git" button's backend action actually creates a
    /// repo against the real git binary on this host.
    #[test]
    fn git_init_makes_a_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path();
        // Sanity: a fresh temp dir is not a git repo.
        assert!(!is_git_repo(path));
        assert!(!path.join(".git").exists());
        // Same invocation the command uses.
        run_git(path, &["init"]).expect("git init succeeds");
        // The proof: .git exists and is_git_repo now reports true.
        assert!(path.join(".git").exists(), ".git was not created");
        assert!(is_git_repo(path), "is_git_repo did not flip to true after init");
    }
}
