//! Git integration via shelling out to the `git` binary (PRD §7.10/§7.11).
//!
//! Everything here degrades gracefully: if git isn't installed or the path
//! isn't a repo, callers get `is_repo: false` / an error string — never a
//! panic. The polling-based status approach is deliberate (PRD §7.11): the
//! frontend re-calls `get_git_status` on an interval rather than us running a
//! filesystem watcher.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

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

/// Unified diff for a SINGLE file in the working tree. The path argument is
/// the path the user clicked in the per-pane diff side panel — repo-relative
/// (the same form `get_changed_files` returns).
///
/// Handles the cases that `git diff HEAD -- <path>` misses on its own:
///   - **Untracked** files (`??`): git won't diff them with `HEAD`. We fall
///     back to `git diff --no-index /dev/null <abs_path>` so a freshly-created
///     code review report or any other new file shows up as an "all added"
///     diff (matches what `git add -N` would do, without mutating the index).
///   - **Staged-only** changes: `git diff HEAD` covers those, so the same
///     command works for "M " (staged) and " M" (unstaged) statuses.
///   - **Renames**: the panel passes the new path; `git diff HEAD` will show
///     the rename detection automatically.
///
/// Returns an empty string when there's no diff to show (clean file).
pub fn get_git_file_diff(path: &Path, file_path: &str) -> Result<String, String> {
    if !path.is_dir() || !is_git_repo(path) {
        return Ok(String::new());
    }
    // First, is the file tracked? `git ls-files --error-unmatch` exits non-zero
    // for untracked paths — that's how we detect them without parsing status.
    let tracked = git_command(
        path,
        &["ls-files", "--error-unmatch", "--", file_path],
    )
    .map(|o| o.status.success())
    .unwrap_or(false);

    if !tracked {
        // Untracked: synthesize an "all added" diff. `git diff --no-index`
        // against /dev/null makes the whole file appear as additions —
        // matching what `git add -N` would show without mutating the index.
        //
        // We invoke the binary directly (not `run_git`) so a non-fatal stderr
        // warning — e.g. Windows' "LF will be replaced by CRLF" — doesn't
        // make the whole call look like a failure. That warning is harmless
        // and the diff on stdout is what we actually want.
        //
        // `--no-index` ignores the `b/` path prefix: it quotes the absolute
        // path verbatim (backslashes and all on Windows) in both the
        // `diff --git` header and the `+++` line. Rather than chase every
        // quoting variant across platforms, build the diff header ourselves
        // and append only the hunk body (everything after the `+++` line),
        // which is what the unified-diff parser actually renders.
        let abs = path.join(file_path);
        let out = git_command(
            path,
            &[
                "diff",
                "--no-index",
                "/dev/null",
                abs.to_string_lossy().as_ref(),
            ],
        )
        .map_err(|e| format!("failed to run git: {e}"))?;
        let raw = String::from_utf8_lossy(&out.stdout).to_string();
        // Drop everything up to and including the `+++ ...` line, then keep
        // the hunks (`@@ ...` and the +/-/context lines).
        let body = match raw.find("\n@@") {
            Some(idx) => &raw[idx + 1..], // skip the newline, start at "@@"
            None => "", // no hunk — empty file or git refused; fall through
        };
        return Ok(format!(
            "diff --git a/{rel} b/{rel}\nnew file mode 100644\n--- /dev/null\n+++ b/{rel}\n{body}",
            rel = file_path,
        ));
    }

    // Tracked: same as the global diff but scoped to one path. Git's path
    // filter is exact-path by default, but for renames the new path is what
    // `get_changed_files` hands us, which is what we want.
    run_git(path, &["diff", "HEAD", "--", file_path])
}

/// One changed file in the working tree, as parsed from `git status --porcelain`.
/// `status` is the 2-char porcelain code (" M", "M ", "??", "A ", "D ", "R ", …).
/// `path` is the path relative to the repo root; renames carry the new path.
/// `oldPath` is set only for renames/copies.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Porcelain code (X + Y); preserve the first char for the index side
    /// ("M " = modified-in-index, " M" = modified-in-worktree, "??" = untracked).
    pub status: String,
    /// Two-letter group: "M" modified, "A" added, "D" deleted, "R" renamed,
    /// "C" copied, "U" untracked, "?" unknown. Used by the UI for icons.
    pub kind: String,
    /// Repo-relative path of the file (new path on renames).
    pub path: String,
    /// Original path on renames; null otherwise.
    pub old_path: Option<String>,
    /// Added line count from `git diff --numstat` (0 for binaries/unknown).
    pub added: u32,
    /// Deleted line count from `git diff --numstat` (0 for binaries/unknown).
    pub deleted: u32,
}

/// Parses `git diff --numstat -z HEAD` output into a map from repo-relative
/// path to (added, deleted). With `-z` the numbers stay TAB-separated and
/// only the path is NUL-terminated (`<added>\t<deleted>\t<path>\0`), so we
/// split on NUL first, then tabs. Binary entries print `-` and count as 0.
fn numstat_map(path: &Path) -> std::collections::HashMap<String, (u32, u32)> {
    let mut map = std::collections::HashMap::new();
    let out = match git_command(path, &["diff", "--numstat", "-z", "HEAD"]) {
        Ok(o) if o.status.success() => o,
        _ => return map,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    for token in text.split('\0') {
        let mut parts = token.split('\t');
        let added = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
        let deleted = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
        let p = parts.collect::<Vec<_>>().join("\t");
        if !p.is_empty() {
            map.insert(p, (added, deleted));
        }
    }
    map
}

/// Numstat (added, deleted) for an UNTRACKED file via
/// `git diff --no-index --numstat -z /dev/null <abs>`. Git won't diff an
/// untracked path against HEAD, so the whole file counts as additions.
/// Returns None when git can't produce a count (binary, empty, etc).
fn no_index_numstat(abs: &Path) -> Option<(u32, u32)> {
    let out = git_command(
        abs.parent()?,
        &[
            "diff",
            "--no-index",
            "--numstat",
            "-z",
            "/dev/null",
            abs.to_string_lossy().as_ref(),
        ],
    )
    .ok()?;
    // NOTE: no `status.success()` check — `git diff --no-index` exits 1 when
    // the files differ, which is exactly the case we're counting. Only the
    // stdout matters.
    let text = String::from_utf8_lossy(&out.stdout);
    let token = text.split('\0').next()?;
    let mut parts = token.split('\t');
    let added = parts.next()?.parse::<u32>().ok()?;
    let deleted = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
    Some((added, deleted))
}

/// Lists changed files in `path`'s working tree, parsed from
/// `git status --porcelain`. Includes staged + unstaged + untracked changes,
/// the same set the existing `get_git_diff` would render. Returns an empty
/// vec when the directory isn't a git repo or has no changes.
///
/// Important: this is a per-pane command — the caller passes the pane's
/// actual working directory (project root OR a worktree path), not just the
/// project root. Per PRD §7.10, sessions may run in a worktree, and the diff
/// panel must reflect THAT directory, not the project root.
pub fn get_changed_files(path: &Path) -> Vec<ChangedFile> {
    if !path.is_dir() || !is_git_repo(path) {
        return Vec::new();
    }
    // `-z` gives NUL-separated, C-quoted paths and avoids any ambiguity with
    // spaces/tabs/quotes in filenames. `--untracked-files=all` so newly-created
    // files in subdirs show up. We keep default rename detection so renames
    // surface as a single R entry (old\0new\0) rather than a D + A pair.
    //
    // NOTE: must go through `git_command` (not `run_git`) — run_git trims the
    // output, but `-z` porcelain entries START with a space for worktree-side
    // changes (" M seed.txt") and that space is part of the entry format.
    let out = match git_command(path, &["status", "--porcelain", "--untracked-files=all", "-z"]) {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let out = String::from_utf8_lossy(&out.stdout).to_string();
    let mut files: Vec<ChangedFile> = Vec::new();
    let mut tokens = out.split('\0');
    while let Some(entry) = tokens.next() {
        // Each entry starts with the 2-char XY status followed by a space, then
        // the path. With -z there is no trailing newline; an empty token means
        // we've consumed the final NUL.
        if entry.is_empty() {
            continue;
        }
        // Need at least "XY " (3 bytes) to have a path.
        let bytes = entry.as_bytes();
        if bytes.len() < 3 {
            continue;
        }
        let status = &entry[0..2];
        // entry[2] is a space; the path follows at [3..].
        let path_str = entry[3..].to_string();
        let kind = porcelain_kind(status);
        // Renames/copies (R/C) emit a SECOND NUL-separated token = the old
        // path. Consume it so the next entry aligns correctly.
        let old_path = if status.starts_with('R') || status.starts_with('C') {
            tokens.next().map(|s| s.to_string())
        } else {
            None
        };
        files.push(ChangedFile {
            status: status.to_string(),
            kind,
            path: path_str,
            old_path,
            added: 0,
            deleted: 0,
        });
    }
    // Per-file line counts: one `--numstat` call covers all tracked changes
    // (staged + unstaged), keyed by path. Untracked files aren't in that
    // output, so count each with a cheap `--no-index` against /dev/null
    // (rare — typically a handful at most).
    let tracked_counts = numstat_map(path);
    for file in files.iter_mut() {
        if file.kind == "U" {
            if let Some((a, d)) = no_index_numstat(&path.join(&file.path)) {
                file.added = a;
                file.deleted = d;
            }
        } else if let Some((a, d)) = tracked_counts.get(&file.path) {
            file.added = *a;
            file.deleted = *d;
        }
    }
    files
}

/// Maps a porcelain XY code to a single-letter UI group. "M" modified, "A"
/// added, "D" deleted, "R" renamed, "C" copied, "U" untracked; "?" for
/// anything unrecognized (merge conflict markers, type changes, etc.).
fn porcelain_kind(status: &str) -> String {
    let x = status.chars().next().unwrap_or('?');
    let y = status.chars().nth(1).unwrap_or(' ');
    // Untracked is the special "??" pair — group as added-ish "U".
    if status == "??" {
        return "U".to_string();
    }
    match x {
        'M' => "M".to_string(),
        'A' => "A".to_string(),
        'D' => "D".to_string(),
        'R' => "R".to_string(),
        'C' => "C".to_string(),
        _ => match y {
            'M' => "M".to_string(),
            'A' => "A".to_string(),
            'D' => "D".to_string(),
            _ => "?".to_string(),
        },
    }
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

    /// `get_changed_files` against a temp repo with a known mix of M / A / ??
    /// files. The -z porcelain path-safety and the rename path are both
    /// covered by the live binary — same shell-out as production.
    #[test]
    fn get_changed_files_lists_modified_added_untracked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path();
        run_git(path, &["init"]).expect("init");
        // Author identity so commits don't error.
        run_git(path, &["config", "user.email", "t@e"]).expect("email");
        run_git(path, &["config", "user.name", "t"]).expect("name");
        // Seed: tracked file.
        std::fs::write(path.join("seed.txt"), "a\n").expect("write seed");
        run_git(path, &["add", "."]).expect("add");
        run_git(path, &["commit", "-m", "init"]).expect("commit");
        // Modify it.
        std::fs::write(path.join("seed.txt"), "a\nb\n").expect("modify");
        // Add a new tracked file.
        std::fs::write(path.join("new.txt"), "n\n").expect("write new");
        run_git(path, &["add", "new.txt"]).expect("add new");
        // Create an untracked file.
        std::fs::write(path.join("untracked.txt"), "u\n").expect("write u");

        let files = get_changed_files(path);
        let kinds: Vec<&str> = files.iter().map(|f| f.kind.as_str()).collect();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        // Modified seed.txt, staged new.txt, untracked untracked.txt — order
        // isn't guaranteed by git, so check membership.
        assert!(kinds.contains(&"M"), "expected a modified entry, got {kinds:?}");
        assert!(kinds.contains(&"A"), "expected an added entry, got {kinds:?}");
        assert!(kinds.contains(&"U"), "expected an untracked entry, got {kinds:?}");
        assert!(paths.contains(&"seed.txt"));
        assert!(paths.contains(&"new.txt"));
        assert!(paths.contains(&"untracked.txt"));
    }

    /// `get_changed_files` on a non-git directory returns an empty vec, not
    /// an error — the UI's empty state relies on this contract.
    #[test]
    fn get_changed_files_empty_on_non_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let files = get_changed_files(dir.path());
        assert!(files.is_empty());
    }

    /// Per-file added/deleted counts come from `--numstat`: a modified tracked
    /// file gets (added, deleted) from `git diff --numstat HEAD`, and an
    /// untracked file counts as all-additions via the `--no-index` fallback.
    #[test]
    fn get_changed_files_includes_numstat_counts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path();
        run_git(path, &["init"]).expect("init");
        run_git(path, &["config", "user.email", "t@e"]).expect("email");
        run_git(path, &["config", "user.name", "t"]).expect("name");
        std::fs::write(path.join("seed.txt"), "a\nb\nc\n").expect("seed");
        run_git(path, &["add", "."]).expect("add");
        run_git(path, &["commit", "-m", "init"]).expect("commit");
        // Modify: drop "b", add "d" and "e".
        std::fs::write(path.join("seed.txt"), "a\nc\nd\ne\n").expect("modify");
        // Untracked file with 2 lines.
        std::fs::write(path.join("fresh.txt"), "x\ny\n").expect("untracked");

        let files = get_changed_files(path);
        let seed = files.iter().find(|f| f.path == "seed.txt").expect("seed entry");
        assert_eq!(seed.added, 2);
        assert_eq!(seed.deleted, 1);
        let fresh = files.iter().find(|f| f.path == "fresh.txt").expect("fresh entry");
        assert_eq!(fresh.added, 2);
        assert_eq!(fresh.deleted, 0);
    }

    /// porcelain_kind should map the two-letter codes to the single-letter
    /// groups the panel's icons/colors use. Staged + worktree side collapse
    /// to the same group so the panel doesn't render "modified" twice.
    #[test]
    fn porcelain_kind_collapses_xy_sides() {
        assert_eq!(porcelain_kind(" M"), "M");
        assert_eq!(porcelain_kind("M "), "M");
        assert_eq!(porcelain_kind("MM"), "M");
        assert_eq!(porcelain_kind("A "), "A");
        assert_eq!(porcelain_kind(" D"), "D");
        assert_eq!(porcelain_kind("??"), "U");
        assert_eq!(porcelain_kind("R "), "R");
        assert_eq!(porcelain_kind("C "), "C");
    }

    /// Regression test for the user-reported bug: clicking a file row in the
    /// Dev-tab diff side panel opened the global diff (filePath:null) and
    /// "nothing showed up." `get_git_file_diff` MUST return a non-empty diff
    /// for both a modified tracked file AND a freshly-created untracked file
    /// (the user's example was a brand-new `code review report.md`).
    #[test]
    fn get_git_file_diff_tracked_and_untracked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path();
        run_git(path, &["init"]).expect("init");
        run_git(path, &["config", "user.email", "t@e"]).expect("email");
        run_git(path, &["config", "user.name", "t"]).expect("name");

        // Tracked file, then modify it.
        std::fs::write(path.join("seed.txt"), "a\n").expect("seed");
        run_git(path, &["add", "."]).expect("add");
        run_git(path, &["commit", "-m", "init"]).expect("commit");
        std::fs::write(path.join("seed.txt"), "a\nb\n").expect("modify");

        let tracked_diff = get_git_file_diff(path, "seed.txt").expect("tracked diff");
        assert!(
            tracked_diff.contains("+b") && tracked_diff.contains("@@"),
            "tracked file diff should have an added line + hunk header, got: {tracked_diff}"
        );

        // Untracked file — the exact "newly-created file" case the user hit.
        std::fs::write(path.join("code review report.md"), "# Review\nbody\n").expect("untracked");
        let untracked_diff =
            get_git_file_diff(path, "code review report.md").expect("untracked diff");
        assert!(
            !untracked_diff.is_empty(),
            "untracked file must yield a synthesized all-added diff, got empty"
        );
        // The no-index fallback should render as additions against /dev/null.
        assert!(
            untracked_diff.contains("--- /dev/null"),
            "untracked diff should be against /dev/null, got: {untracked_diff}"
        );
        assert!(
            untracked_diff.contains("+++ b/code review report.md"),
            "untracked diff header should be the repo-relative b/<path> form, got: {untracked_diff}"
        );
    }
}
