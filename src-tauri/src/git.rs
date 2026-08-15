//! Git integration via shelling out to the `git` binary (PRD §7.10/§7.11).
//!
//! Everything here degrades gracefully: if git isn't installed or the path
//! isn't a repo, callers get `is_repo: false` / an error string — never a
//! panic. The polling-based status approach is deliberate (PRD §7.11): the
//! frontend re-calls `get_git_status` on an interval rather than us running a
//! filesystem watcher.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::types::GitStatusInfo;

const DIFF_CAP_BYTES: usize = 200 * 1024;

/// Hard ceiling on any single git subprocess. Normal operations finish in well
/// under a second; this bounds the rare slow case (large push, slow network) so
/// a hung operation can never block the UI indefinitely. The credential-prompt
/// case is handled separately (and fails in ~1s) via GIT_TERMINAL_PROMPT=0.
const GIT_TIMEOUT: Duration = Duration::from_secs(90);

fn git_command(
    cwd: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
) -> std::io::Result<std::process::Output> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    // Extra environment (e.g. GIT_INDEX_FILE for checkpoint snapshots so the
    // user's real index is never touched).
    cmd.envs(envs.iter().copied());
    // This is a detached GUI process with no console. Without these env vars,
    // a `git push` needing auth hangs forever on a stdin prompt that can never
    // be answered. GIT_TERMINAL_PROMPT=0 makes git fail fast; GCM_INTERACTIVE=
    // never tells the Git Credential Manager not to pop a UI dialog.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GCM_INTERACTIVE", "never");
    // Null stdin so git can't block waiting for interactive input, and piped
    // outputs so we can drain them concurrently (see below).
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Prevent console-window flashes when the GUI app shells out on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()?;

    // Drain stdout/stderr on background threads. Without concurrent draining,
    // git blocks once its 64KB pipe buffer fills and would never exit — a
    // classic subprocess deadlock. Each thread reads its pipe to EOF.
    let mut stdout = child
        .stdout
        .take()
        .expect("piped stdout is present right after spawn");
    let mut stderr = child
        .stderr
        .take()
        .expect("piped stderr is present right after spawn");
    let out_handle =
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = stdout.read_to_end(&mut v);
            v
        });
    let err_handle =
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = stderr.read_to_end(&mut v);
            v
        });

    // Poll for exit with a timeout. try_wait doesn't block, so we can check
    // the deadline between polls and kill a hung child.
    let start = Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None => {
                if start.elapsed() >= GIT_TIMEOUT {
                    // Kill + reap so we don't leak a zombie, then surface the
                    // stderr captured so far (often the auth-failure message).
                    let _ = child.kill();
                    let _ = child.wait();
                    let err_bytes = err_handle.join().unwrap_or_default();
                    let stderr_text = String::from_utf8_lossy(&err_bytes);
                    let tail = if stderr_text.trim().is_empty() {
                        String::new()
                    } else {
                        format!("\nstderr: {}", stderr_text.trim())
                    };
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!(
                            "git {} timed out after {}s{tail}",
                            args.join(" "),
                            GIT_TIMEOUT.as_secs(),
                        ),
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };

    let stdout_bytes = out_handle.join().expect("stdout drain thread panicked");
    let stderr_bytes = err_handle.join().expect("stderr drain thread panicked");

    Ok(std::process::Output {
        status,
        stdout: stdout_bytes,
        stderr: stderr_bytes,
    })
}

/// Ok(stdout trimmed) on success, Err(stderr trimmed or message) otherwise.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run_git_env(cwd, args, &[])
}

/// `run_git` with extra environment variables (checkpoint plumbing needs
/// `GIT_INDEX_FILE` to stage snapshots without touching the user's index).
pub(crate) fn run_git_env(cwd: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<String, String> {
    let out = git_command(cwd, args, envs).map_err(|e| format!("failed to run git: {e}"))?;
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
/// Validate that a renderer-supplied "repo-relative" file path really is one.
///
/// SECURITY: `get_git_file_diff` passes `file_path` into `git diff --` and
/// joins it onto the repo root. `Path::join` silently DISCARDS the base when
/// handed an absolute path, and a `..` component walks out of the repo — either
/// lets a compromised renderer read arbitrary files on disk. Reject both, then
/// verify the lexically-normalized joined path still sits under the repo root
/// (belt-and-suspenders against component forms we didn't enumerate).
fn validate_repo_relative(repo: &Path, file_path: &str) -> Result<(), String> {
    let rel = Path::new(file_path);
    if rel.is_absolute() {
        return Err("file_path must be relative to the repository root".to_string());
    }
    if rel
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("file_path must not contain '..'".to_string());
    }
    // components() also drops interior "." segments, so collecting them is our
    // cheap lexical normalization (no fs access — the path may not exist yet).
    let normalized: PathBuf = repo.join(rel).components().collect();
    if !crate::util::path_starts_with_ci(&normalized, repo) {
        return Err("file_path escapes the repository root".to_string());
    }
    Ok(())
}

/// Returns an empty string when there's no diff to show (clean file).
pub fn get_git_file_diff(path: &Path, file_path: &str) -> Result<String, String> {
    if !path.is_dir() || !is_git_repo(path) {
        return Ok(String::new());
    }
    validate_repo_relative(path, file_path)?;
    // First, is the file tracked? `git ls-files --error-unmatch` exits non-zero
    // for untracked paths — that's how we detect them without parsing status.
    let tracked = git_command(
        path,
        &["ls-files", "--error-unmatch", "--", file_path],
        &[],
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
            &[],
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
/// Rename records are different: the path slot is empty (`<a>\t<d>\t\0`) and
/// TWO NUL-terminated path tokens follow (old path, then new path).
fn numstat_map(path: &Path) -> std::collections::HashMap<String, (u32, u32)> {
    let mut map = std::collections::HashMap::new();
    let out = match git_command(path, &["diff", "--numstat", "-z", "HEAD"], &[]) {
        Ok(o) if o.status.success() => o,
        _ => return map,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut tokens = text.split('\0');
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        let mut parts = token.split('\t');
        let added = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
        let deleted = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
        let p = parts.collect::<Vec<_>>().join("\t");
        if !p.is_empty() {
            map.insert(p, (added, deleted));
        } else {
            // Rename record: consume the old-path token, key counts on the new.
            tokens.next();
            if let Some(new_path) = tokens.next() {
                if !new_path.is_empty() {
                    map.insert(new_path.to_string(), (added, deleted));
                }
            }
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
        &[],
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
    // Hard caps for pathological trees (a huge unignored directory like
    // node_modules or build output inside the repo). Without them,
    // `--untracked-files=all` enumerates every file and the per-untracked-file
    // `git diff --no-index` below spawns ONE SUBPROCESS PER FILE — tens of
    // thousands of git processes froze the whole app when such a project was
    // selected. The diff panel can't usefully show more than this anyway.
    const MAX_CHANGED_FILES: usize = 1000;
    const MAX_UNTRACKED_LINE_COUNTS: usize = 50;
    // `-z` gives NUL-separated, C-quoted paths and avoids any ambiguity with
    // spaces/tabs/quotes in filenames. `--untracked-files=all` so newly-created
    // files in subdirs show up. We keep default rename detection so renames
    // surface as a single R entry (old\0new\0) rather than a D + A pair.
    //
    // NOTE: must go through `git_command` (not `run_git`) — run_git trims the
    // output, but `-z` porcelain entries START with a space for worktree-side
    // changes (" M seed.txt") and that space is part of the entry format.
    let out = match git_command(path, &["status", "--porcelain", "--untracked-files=all", "-z"], &[]) {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let out = String::from_utf8_lossy(&out.stdout).to_string();
    let mut files: Vec<ChangedFile> = Vec::new();
    let mut tokens = out.split('\0');
    while let Some(entry) = tokens.next() {
        if files.len() >= MAX_CHANGED_FILES {
            break;
        }
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
    // output, so count each with a cheap `--no-index` against /dev/null —
    // but ONLY for a handful (see MAX_UNTRACKED_LINE_COUNTS): beyond that we
    // leave the counts at 0 rather than spawn a subprocess per file.
    let tracked_counts = numstat_map(path);
    let mut untracked_counted = 0usize;
    for file in files.iter_mut() {
        if file.kind == "U" {
            if untracked_counted < MAX_UNTRACKED_LINE_COUNTS {
                if let Some((a, d)) = no_index_numstat(&path.join(&file.path)) {
                    file.added = a;
                    file.deleted = d;
                }
                untracked_counted += 1;
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

// ---- Branch management ----

/// A local or remote branch from `git branch`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub last_commit_sha: String,
    pub last_commit_message: String,
}

/// List all branches (local + remote) with their last commit info.
/// Format: `%(refname:short)|%(objectname:short)|%(contents:subject)` per
/// line, prefixed with `*` for the current branch and `remotes/` for remote.
pub fn list_branches(path: &Path) -> Result<Vec<BranchInfo>, String> {
    let format = "%(refname:short)|%(objectname:short)|%(contents:subject)";
    // Use --format with a marker for the current branch.
    let out = git_command(
        path,
        &[
            "branch",
            "--all",
            "--format=%(HEAD)%(refname:short)\u{1f}",
        ],
        &[],
    )
    .map_err(|e| format!("failed to run git branch: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);

    // We need the format with sha + subject too — do a second call with the
    // full format and match by name. Simpler: one call with everything.
    let detailed = run_git(
        path,
        &[
            "for-each-ref",
            "--format=%(HEAD)\u{1f}%(refname:short)\u{1f}%(objectname:short)\u{1f}%(contents:subject)",
            "refs/heads/",
            "refs/remotes/",
        ],
    )?;

    let mut branches = Vec::new();
    for line in detailed.lines() {
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() < 4 {
            continue;
        }
        let head_marker = parts[0].trim();
        let full_name = parts[1].trim();
        let sha = parts[2].trim();
        let msg = parts[3].trim();
        let is_current = head_marker == "*";
        let is_remote = full_name.starts_with("remotes/");
        // Strip "remotes/" prefix for a cleaner display name.
        let name = if is_remote {
            full_name.strip_prefix("remotes/").unwrap_or(full_name).to_string()
        } else {
            full_name.to_string()
        };
        // Skip HEAD symlink ref (e.g. "origin/HEAD -> origin/main").
        if name.contains(" -> ") {
            continue;
        }
        branches.push(BranchInfo {
            name,
            is_current,
            is_remote,
            last_commit_sha: sha.to_string(),
            last_commit_message: msg.to_string(),
        });
    }
    // Suppress unused warning for the first stdout parse.
    let _ = stdout;
    Ok(branches)
}

/// Create a new branch and check it out (`git checkout -b <name>`).
pub fn create_branch(path: &Path, name: &str) -> Result<(), String> {
    // Reject names that could be interpreted as flags.
    if name.starts_with('-') || name.is_empty() {
        return Err("invalid branch name".to_string());
    }
    run_git(path, &["checkout", "-b", name]).map(|_| ())
}

/// Switch to an existing branch (`git checkout <name>`).
pub fn checkout_branch(path: &Path, name: &str) -> Result<(), String> {
    if name.starts_with('-') || name.is_empty() {
        return Err("invalid branch name".to_string());
    }
    // For remote branches, strip the remote prefix so checkout creates a local
    // tracking branch automatically (git's DWIM). Only strip when the prefix
    // before the first '/' is a KNOWN remote — plain `checkout <stripped>`
    // would otherwise silently check out the wrong local branch for a local
    // branch name that itself contains a '/' (e.g. `feature/x`).
    let local_name = match name.split_once('/') {
        Some((prefix, rest)) if !rest.is_empty() => {
            let remotes = run_git(path, &["remote"]).unwrap_or_default();
            let is_remote = remotes.lines().map(str::trim).any(|r| r == prefix);
            if is_remote { rest } else { name }
        }
        _ => name,
    };
    run_git(path, &["checkout", local_name]).map(|_| ())
}

/// Delete a local branch (`git branch -d <name>`).
pub fn delete_branch(path: &Path, name: &str) -> Result<(), String> {
    if name.starts_with('-') || name.is_empty() {
        return Err("invalid branch name".to_string());
    }
    run_git(path, &["branch", "-d", name]).map(|_| ())
}

/// Get the origin remote URL (for the GitHub pill link). None if no remote.
pub fn get_remote_url(path: &Path) -> Option<String> {
    run_git(path, &["remote", "get-url", "origin"]).ok()
}

/// Stage all changes and commit with the given message.
/// Returns the commit SHA on success.
pub fn git_commit(path: &Path, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message must not be empty".to_string());
    }
    run_git(path, &["add", "."])?;
    run_git(path, &["commit", "-m", message])?;
    // Get the new commit SHA for feedback.
    run_git(path, &["rev-parse", "--short", "HEAD"])
}

/// Push the current branch to origin. Returns the push output.
pub fn git_push(path: &Path) -> Result<String, String> {
    let branch = run_git(path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    run_git(path, &["push", "origin", &branch])
}

/// A compact `git log --oneline --graph` line for the git graph view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub graph: String,
    pub sha: String,
    pub message: String,
    pub refs: String,
}

/// Recent commit log with graph lines (last 50 commits).
pub fn get_git_log(path: &Path) -> Result<Vec<GitLogEntry>, String> {
    let out = run_git(
        path,
        &[
            "log",
            "--oneline",
            "--graph",
            "--decorate",
            "-n",
            "50",
            "--format=%h\u{1f}%s\u{1f}%d",
        ],
    )?;
    let mut entries = Vec::new();
    for line in out.lines() {
        // Graph prefix is everything before the first SHA (short hash pattern).
        // Format: [<graph chars>] <sha> <subject> (<refs>)
        // Split on the first space to separate graph from the rest.
        let trimmed = line;
        // Find where the graph ends: the graph is leading * | / \ characters.
        let graph_end = trimmed
            .char_indices()
            .take_while(|(_, c)| matches!(c, '*' | '|' | '/' | '\\' | ' ' | '_' | '.'))
            .last()
            .map(|(i, _)| i + 1)
            .unwrap_or(0);
        let graph = trimmed[..graph_end].trim_end().to_string();
        let rest = trimmed[graph_end..].trim();
        // rest = "<sha> <subject> (<refs>)" — split on first space.
        let (sha_part, msg_part) = rest
            .split_once(' ')
            .unwrap_or((rest, ""));
        entries.push(GitLogEntry {
            graph,
            sha: sha_part.to_string(),
            message: msg_part.to_string(),
            refs: String::new(), // refs are embedded in message with --decorate
        });
    }
    Ok(entries)
}

// ---- per-turn checkpoints (hidden refs, plumbing only) ----
//
// A checkpoint snapshots the ENTIRE working tree (tracked + untracked,
// .gitignore respected) into a commit object hanging off a hidden ref under
// `refs/conduit/checkpoints/…`. Everything here uses a TEMP index
// (`GIT_INDEX_FILE`), so the user's real index, HEAD, and working tree are
// never touched by snapshot creation.

/// SHA of git's empty tree — the diff base for the first checkpoint of a
/// session when there is no previous checkpoint to diff against.
const EMPTY_TREE_SHA: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// A working-tree snapshot: the tree object (content identity — used for
/// turn-changed-nothing dedup) and the wrapping commit object (what the
/// hidden ref points at). `commit_sha` is None only if `commit-tree` was
/// skipped, which never happens in practice; kept for API honesty.
#[derive(Debug, Clone)]
pub struct CheckpointSnapshot {
    pub tree_sha: String,
    pub commit_sha: Option<String>,
}

/// One entry in a checkpoint's files-changed list (vs the previous
/// checkpoint). `status` is a git name-status letter: A / M / D.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFileChange {
    pub path: String,
    pub status: String,
}

/// Stage the full working tree into a throwaway index and write tree + commit
/// objects. Does NOT create any ref and does NOT touch HEAD/index/worktree.
pub fn snapshot_working_tree(cwd: &Path) -> Result<CheckpointSnapshot, String> {
    // Unique temp-index path per call (pid + nanos); removed at the end.
    let tmp_index = std::env::temp_dir().join(format!(
        "conduit-ckpt-idx-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    ));
    let idx = tmp_index.to_string_lossy().to_string();
    // Explicit author/committer identity: checkpoint commits are app-made
    // bookkeeping objects and must never fail because a machine has no
    // global git user.name/user.email configured.
    let envs: &[(&str, &str)] = &[
        ("GIT_INDEX_FILE", idx.as_str()),
        ("GIT_AUTHOR_NAME", "Conduit"),
        ("GIT_AUTHOR_EMAIL", "checkpoints@conduit.local"),
        ("GIT_COMMITTER_NAME", "Conduit"),
        ("GIT_COMMITTER_EMAIL", "checkpoints@conduit.local"),
    ];
    let result = (|| -> Result<CheckpointSnapshot, String> {
        run_git_env(cwd, &["add", "-A", "--", "."], envs)?;
        let tree_sha = run_git_env(cwd, &["write-tree"], envs)?;
        // Parent = current HEAD when the repo has commits (keeps checkpoints
        // visible in `git log` context); root commit otherwise.
        let head = run_git(cwd, &["rev-parse", "HEAD"]).ok();
        let commit_sha = match &head {
            Some(h) => run_git_env(
                cwd,
                &["commit-tree", &tree_sha, "-p", h, "-m", "conduit checkpoint"],
                envs,
            )?,
            None => run_git_env(
                cwd,
                &["commit-tree", &tree_sha, "-m", "conduit checkpoint"],
                envs,
            )?,
        };
        Ok(CheckpointSnapshot {
            tree_sha,
            commit_sha: Some(commit_sha),
        })
    })();
    let _ = std::fs::remove_file(&tmp_index);
    result
}

/// Files that differ between two checkpoints' trees (`old_tree` = previous
/// checkpoint, or the empty tree for a session's first). Renames are NOT
/// detected (`--no-renames`) so every entry is a single path with an
/// A/M/D status letter.
pub fn checkpoint_files_diff(
    cwd: &Path,
    old_tree: &str,
    new_tree: &str,
) -> Result<Vec<CheckpointFileChange>, String> {
    let out = run_git(
        cwd,
        &[
            "diff",
            "--name-status",
            "--no-renames",
            "-z",
            old_tree,
            new_tree,
        ],
    )?;
    // -z format: "XY\0path\0XY\0path\0…" (no trailing NUL).
    let mut files = Vec::new();
    let mut fields = out.split('\0');
    while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
        if status.is_empty() || path.is_empty() {
            continue;
        }
        // Status may carry a score suffix (e.g. "M100"); keep the letter.
        let letter = status.chars().next().unwrap_or('M').to_string();
        files.push(CheckpointFileChange {
            path: path.to_string(),
            status: letter,
        });
    }
    Ok(files)
}

/// Point (or move) a hidden checkpoint ref at a commit. Creating the ref is
/// the ONLY visible side effect of a checkpoint.
pub fn update_checkpoint_ref(cwd: &Path, ref_name: &str, commit_sha: &str) -> Result<(), String> {
    run_git(cwd, &["update-ref", ref_name, commit_sha]).map(|_| ())
}

/// Drop a checkpoint ref (object stays until gc — restore-by-id would fail
/// only after a manual gc prune, which is fine for deleted sessions).
pub fn delete_checkpoint_ref(cwd: &Path, ref_name: &str) -> Result<(), String> {
    run_git(cwd, &["update-ref", "-d", ref_name]).map(|_| ())
}

/// Roll the working tree + index back to a checkpoint tree, then unstage so
/// the delta vs HEAD shows as ordinary unstaged changes in the git panel.
/// Destructive by design — callers MUST take a safety snapshot first.
///
/// `read-tree -u --reset` alone only removes files that were in the REAL
/// index; files the agent created untracked (never staged) would survive.
/// So the extras are computed by tree-diff (files in the current full tree
/// but not in the target tree) and deleted explicitly.
pub fn restore_checkpoint_tree(cwd: &Path, tree_sha: &str) -> Result<(), String> {
    // Full snapshot of the CURRENT tree (temp index — user index untouched)
    // to diff the target against for extra-file deletion.
    let current = snapshot_working_tree(cwd)?;
    run_git(cwd, &["read-tree", "-u", "--reset", tree_sha])?;
    // target → current diff: "A" entries exist in the CURRENT tree but not in
    // the target — the agent-created extras read-tree can't know about.
    // ("D" is the opposite: restored-by-read-tree files — leave those alone.)
    if let Ok(extras) = checkpoint_files_diff(cwd, tree_sha, &current.tree_sha) {
        for extra in extras.iter().filter(|f| f.status == "A") {
            // Paths come from git tree-diff output (repo-relative, no
            // traversal), but validate anyway — defense in depth.
            if validate_repo_relative(cwd, &extra.path).is_ok() {
                let abs = cwd.join(&extra.path);
                let _ = std::fs::remove_file(&abs);
            }
        }
    }
    // `reset` (mixed) needs HEAD to exist; on a fresh repo without commits
    // the read-tree above already left a matching index, so skip.
    if run_git(cwd, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        run_git(cwd, &["reset"])?;
    }
    Ok(())
}

/// Parse `list` results back out (helper for tests).
pub fn empty_tree_sha() -> &'static str {
    EMPTY_TREE_SHA
}

/// Test-only: init a committed temp repo via the same shell-out path (used by
/// checkpoint orchestration tests outside this module).
#[cfg(test)]
pub(crate) fn init_test_repo(path: &Path) {
    run_git(path, &["init"]).expect("git init");
    run_git(path, &["config", "user.email", "t@e"]).expect("email");
    run_git(path, &["config", "user.name", "t"]).expect("name");
    std::fs::write(path.join("seed.txt"), "seed\n").expect("seed");
    run_git(path, &["add", "."]).expect("add");
    run_git(path, &["commit", "-m", "init"]).expect("commit");
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

    /// A2: `get_git_file_diff` must reject renderer-supplied paths that would
    /// escape the repo (`Path::join` discards the base for absolute inputs,
    /// `..` walks out of the tree) — otherwise `git diff --no-index` becomes
    /// an arbitrary-file read.
    #[test]
    fn repo_relative_validation_rejects_escapes() {
        let repo = Path::new("/home/u/myproj");
        // Plain relative paths (the normal case) pass.
        assert!(validate_repo_relative(repo, "src/main.rs").is_ok());
        assert!(validate_repo_relative(repo, "deep/nested/file.txt").is_ok());
        // Interior "." is harmless after normalization.
        assert!(validate_repo_relative(repo, "./src/main.rs").is_ok());
        // Absolute paths: POSIX and Windows drive/UNC forms.
        assert!(validate_repo_relative(repo, "/etc/passwd").is_err());
        assert!(validate_repo_relative(repo, "C:/Windows/system32/config").is_err());
        assert!(validate_repo_relative(repo, "\\\\server\\share\\secret").is_err());
        // Parent traversal in any position.
        assert!(validate_repo_relative(repo, "../outside.txt").is_err());
        assert!(validate_repo_relative(repo, "src/../../outside.txt").is_err());
        assert!(validate_repo_relative(repo, "src/../..").is_err());
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

    /// Regression test: with `--numstat -z`, a rename record has an empty path
    /// slot followed by TWO NUL-terminated tokens (old path, new path). The
    /// parser used to consume only one, so a renamed+modified file showed 0/0
    /// line counts (and the old path got a bogus 0/0 entry).
    #[test]
    fn get_changed_files_numstat_rename_record() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path();
        run_git(path, &["init"]).expect("init");
        run_git(path, &["config", "user.email", "t@e"]).expect("email");
        run_git(path, &["config", "user.name", "t"]).expect("name");
        // Enough lines that a small edit still clears the rename-similarity bar.
        std::fs::write(path.join("old.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n").expect("seed");
        run_git(path, &["add", "."]).expect("add");
        run_git(path, &["commit", "-m", "init"]).expect("commit");
        // Rename + small modification: drop "b", add "x".
        run_git(path, &["mv", "old.txt", "renamed.txt"]).expect("mv");
        std::fs::write(path.join("renamed.txt"), "a\nc\nd\ne\nf\ng\nh\nx\n").expect("modify");

        let files = get_changed_files(path);
        let renamed = files
            .iter()
            .find(|f| f.path == "renamed.txt")
            .expect("renamed entry");
        assert_eq!(renamed.added, 1, "rename record should keep its counts");
        assert_eq!(renamed.deleted, 1, "rename record should keep its counts");
        // The old path must not leak in as a bogus 0/0 numstat entry.
        assert!(
            !files.iter().any(|f| f.path == "old.txt"),
            "old rename path should not appear as a changed file, got {files:?}"
        );
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

    // ---- checkpoint plumbing tests (real git binary, temp repos) ----

    /// Init a committed temp repo with one tracked file. Returns its path.
    fn ckpt_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path();
        run_git(path, &["init"]).expect("init");
        run_git(path, &["config", "user.email", "t@e"]).expect("email");
        run_git(path, &["config", "user.name", "t"]).expect("name");
        std::fs::write(path.join("app.txt"), "v1\n").expect("seed");
        run_git(path, &["add", "."]).expect("add");
        run_git(path, &["commit", "-m", "init"]).expect("commit");
        dir
    }

    #[test]
    fn checkpoint_snapshot_round_trip_dedup_and_files_diff() {
        let dir = ckpt_repo();
        let path = dir.path();

        // Baseline snapshot of the clean tree (pre-chat state).
        let base = snapshot_working_tree(path).expect("baseline snapshot");
        assert_eq!(base.tree_sha.len(), 40, "full tree sha");
        assert!(base.commit_sha.is_some());

        // Snapshot is read-only wrt the working tree + user index: `git
        // status --porcelain` must still show no changes after it ran.
        let status = run_git(path, &["status", "--porcelain"]).expect("status");
        assert!(status.is_empty(), "snapshot must not dirty the tree: {status}");

        // No changes → identical tree sha (turn-changed-nothing dedup).
        let same = snapshot_working_tree(path).expect("second snapshot");
        assert_eq!(same.tree_sha, base.tree_sha, "identical trees dedup");

        // Simulate a turn: edit + add a file, delete nothing.
        std::fs::write(path.join("app.txt"), "v2\n").expect("edit");
        std::fs::write(path.join("new.rs"), "fn main() {}\n").expect("new");
        let after = snapshot_working_tree(path).expect("post-turn snapshot");
        assert_ne!(after.tree_sha, base.tree_sha);

        // Files diff vs baseline: M app.txt, A new.rs (order not guaranteed).
        let files = checkpoint_files_diff(path, &base.tree_sha, &after.tree_sha).expect("diff");
        let got: Vec<(&str, &str)> = files.iter().map(|f| (f.status.as_str(), f.path.as_str())).collect();
        assert!(got.contains(&("M", "app.txt")), "got {got:?}");
        assert!(got.contains(&("A", "new.rs")), "got {got:?}");
        assert_eq!(files.len(), 2, "exactly the two changed files, got {got:?}");

        // Ref creation + listing under the hidden namespace. NOTE: no glob —
        // for-each-ref's `*` doesn't cross `/` (wildmatch WM_PATHNAME), so a
        // bare prefix is the correct way to list the whole namespace.
        let commit = after.commit_sha.clone().expect("commit sha");
        update_checkpoint_ref(path, "refs/conduit/checkpoints/s1/1", &commit).expect("update-ref");
        let refs = run_git(path, &["for-each-ref", "--format=%(refname)", "refs/conduit/checkpoints"])
            .expect("for-each-ref");
        assert!(refs.contains("refs/conduit/checkpoints/s1/1"), "refs: {refs}");
        delete_checkpoint_ref(path, "refs/conduit/checkpoints/s1/1").expect("delete ref");
        let refs = run_git(path, &["for-each-ref", "--format=%(refname)", "refs/conduit/checkpoints"])
            .expect("for-each-ref 2");
        assert!(!refs.contains("s1/1"), "ref should be gone: {refs}");
    }

    #[test]
    fn checkpoint_restore_rolls_tree_back_and_deletes_extras() {
        let dir = ckpt_repo();
        let path = dir.path();

        // Turn 1: good state — snapshot it.
        std::fs::write(path.join("good.txt"), "keep me\n").expect("good");
        let good = snapshot_working_tree(path).expect("snapshot 1");

        // Turn 2: agent wrecks things — edits, adds junk, deletes a file.
        std::fs::write(path.join("app.txt"), "wrecked\n").expect("wreck");
        std::fs::write(path.join("junk.txt"), "junk\n").expect("junk");
        std::fs::remove_file(path.join("good.txt")).expect("delete good");
        let wrecked = snapshot_working_tree(path).expect("snapshot 2");
        assert_ne!(good.tree_sha, wrecked.tree_sha);

        // Restore the good snapshot.
        restore_checkpoint_tree(path, &good.tree_sha).expect("restore");

        // Working tree matches the snapshot exactly. Content compares
        // trim_end — with core.autocrlf=true (typical Windows) a restored
        // file checks out with CRLF while the test wrote LF.
        assert_eq!(
            std::fs::read_to_string(path.join("app.txt")).unwrap().trim_end(),
            "v1",
            "edit rolled back"
        );
        assert!(path.join("good.txt").exists(), "deleted file restored");
        assert!(!path.join("junk.txt").exists(), "extra file removed");

        // And the delta vs HEAD reads as unstaged changes (git reset ran) —
        // good.txt is an untracked addition, app.txt is clean again.
        let status = run_git(path, &["status", "--porcelain"]).expect("status");
        assert!(status.contains("?? good.txt"), "restored file shows untracked, got: {status}");
        assert!(!status.contains("app.txt"), "app.txt should match HEAD again: {status}");
    }

    #[test]
    fn checkpoint_snapshot_works_in_repo_without_commits() {
        // Fresh `git init` — no HEAD yet. Snapshot must still work and the
        // commit must be a root commit (no -p parent).
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path();
        run_git(path, &["init"]).expect("init");
        std::fs::write(path.join("a.txt"), "a\n").expect("a");
        let snap = snapshot_working_tree(path).expect("snapshot in empty repo");
        assert!(snap.commit_sha.is_some());
        let commit = snap.commit_sha.unwrap();
        // Parent count must be 0.
        let parents = run_git(path, &["rev-list", "--parents", "-n", "1", &commit]).expect("parents");
        assert_eq!(parents.split_whitespace().count(), 1, "root commit has no parent: {parents}");
    }

    #[test]
    fn checkpoint_files_diff_empty_tree_base_lists_everything_as_added() {
        let dir = ckpt_repo();
        let path = dir.path();
        std::fs::write(path.join("extra.txt"), "x\n").expect("extra");
        let snap = snapshot_working_tree(path).expect("snapshot");
        // First checkpoint of a session diffs against the EMPTY tree — every
        // file (tracked + the untracked extra) shows as A.
        let files = checkpoint_files_diff(path, empty_tree_sha(), &snap.tree_sha).expect("diff");
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"app.txt") && paths.contains(&"extra.txt"), "{paths:?}");
        assert!(files.iter().all(|f| f.status == "A"), "all additions vs empty tree");
    }
}
