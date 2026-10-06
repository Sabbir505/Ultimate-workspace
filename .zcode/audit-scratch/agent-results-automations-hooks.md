# Agent findings: automations/hooks/git (12 files)
# Status: COMPLETE — verified result captured 2026-10-02 19:16

FILES COVERED: src-tauri/src/{automations,automation_triggers,automation_task,automation_webhook,automation_templates}.rs, bin/relay_automation.rs, hooks.rs, installed_skills.rs, skills_gallery.rs, git.rs, git_watcher.rs, github.rs (cross-checked against lib.rs, db/automations.rs, chat/mod.rs, commands/automation_cmds.rs where needed).

## P0

**1. Zip-slip via Windows backslash path separators — arbitrary file write outside the skill root — installed_skills.rs:966-973.**
```rust
let rel_path = std::path::Path::new(rel);
if rel_path.is_absolute() || rel.split('/').any(|seg| seg == "..") {
    return Err(format!("unsafe archive path: {rel}"));
}
let target = dir.join(rel_path);
```
The traversal guard only splits on `/`. On Windows (primary platform), a zip entry `zip-skill/..\..\evil.txt` passes `install_zip`'s prefix filter (:1219), yields `rel = "..\..\evil.txt"` with no `/`-delimited `..` segment, and `dir.join(rel_path)` resolves `..\` as ParentDir components — writing outside `<home>/.claude/skills/<slug>/` (`create_dir_all(parent)` creates the escaped dirs). With enough `..\` segments: arbitrary relative file write (startup scripts, `.claude` config) from clicking "install" on a hostile .zip URL. Same bypass via GitHub tree path: `install_github_tree`'s fallback `path.rsplit('/').next()` (:1152-1155) forwards a trailing `..\evil.txt` filename verbatim. The regression test (`zip_slip_paths_are_refused`, :1624) only exercises the forward-slash form. Fix: reject on path components — `rel_path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) || rel.contains('\\')` — mirroring `git.rs::validate_repo_relative`; add a backslash-form test.

## P1

**2. No stale-run reaping — quitting or crashing mid-run leaves `automation_runs` stuck status='running' forever — automations.rs:629-640, finalize only at :854-901.**
The exit path kills only PTYs/MCP children (lib.rs:1154-1161); the boot sweep covers subagent runs only (lib.rs:350-353). Runs last up to MAX_RUN_SECS = 2h, so a routine app close during a run permanently leaves the run row (and its mirrored `improve_runs` row, db/automations.rs:344) at `finished_at IS NULL, status='running'` — phantom in-progress run in Past Runs forever, skewed improve stats. The cross-process lock file HAS PID-based stale detection (B-28); the DB rows do not. Fix: at boot next to `sweep_stale_subagent_runs`, `UPDATE automation_runs SET status='interrupted', finished_at=now WHERE finished_at IS NULL` (age-gated for multi-instance), close linked improve_runs like `finish_run` does.

**3. Blocking scheduler work runs directly on the tokio async runtime worker — automations.rs:122-127 (interval loop) → tick :179 → `evaluate_git_triggers`.**
`git_rev_parse` (automation_triggers.rs:366-378) polls `child.try_wait()` with `std::thread::sleep(20ms)` up to 5s per repo, plus parking_lot DB locks held across it. Every 30s tick blocks a shared worker; a slow/hung `git` (network drive — the exact case the 5s bound anticipates) blocks a worker 5s × N git automations serially, starving the runtime serving every async #[tauri::command] and the webhook listener. github.rs already wraps its git subprocesses in spawn_blocking (:87-92, :1014). Fix: wrap the tick body (or `evaluate_git_triggers`) in `tauri::async_runtime::spawn_blocking`.

**4. GitHub tree installs silently drop all subdirectory content — installed_skills.rs:1147-1150.**
`github_list_dir` (:1019-1041) returns a single level of the contents API and the loop skips `is_dir` entries without recursing — `scripts/`, `reference/`, `assets/` siblings of SKILL.md are never fetched, contradicting the function's own contract (:1117-1118 "one level + subdirectory children"). The Skills Gallery one-click install routes through this; cataloged anthropics skills ship subdirectories, so installs are silently incomplete and SKILL.md bodies reference missing files. The only test of this path is #[ignore]d. Fix: recurse the contents API per subdirectory (bounded by existing MAX_ARCHIVE_FILES/MAX_ARCHIVE_FILE_BYTES), computing rel paths with `strip_prefix(&git_ref.path)`.

## P2

**5. `fetch_capped` buffers the entire response before enforcing the size cap — installed_skills.rs:1004-1014.**
`resp.bytes().await` reads the full body; only afterwards `if bytes.len() > cap` rejects. The comment (:867-868) claims "Size caps bound memory anyway" — as written they don't: a hostile "install this skill" link or redirect to a large stream is fully downloaded before the cap fires. Fix: stream with `resp.chunk()` and abort once the accumulator exceeds cap.

**6. Hook timeout kills only the direct child, not its process tree — orphaned grandchildren survive — hooks.rs:494-499 (.kill_on_drop(true)), 552-558 (timeout drops the future).**
No job object on Windows; a hook that spawns children — the DEFAULT for imported Claude hooks, since `parse_claude_hooks` wraps every command as `cmd /C <line>` (:891-895) — leaves the whole child tree (node, compilers, watchers) running forever on timeout. Fix: Windows Job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE closed on timeout; Unix `process_group(0)` + `kill(-pgid, SIGKILL)`.

**7. `list_branches` executes `git branch --all` and discards its output — git.rs:813-828, then :872-874 `let _ = stdout;`.**
Real data comes from the second `for-each-ref` call; every branch listing pays double subprocess latency for zero value (`_format` at :813 is dead). Fix: delete the first call, its parse, and the unused const.

**8. `github_list_issue_comments` returns the oldest 50 comments, not the newest — github.rs:864-866.**
Request sends only `per_page=50` with no sort/direction; GitHub's default is ascending, so page 1 is the OLDEST 50. Doc comment (:855 "newest 50, oldest first") is self-contradictory; issues with >50 comments never show recent comments. Fix: `sort=created&direction=desc` + reverse the vec for oldest-first rendering.

**9. Hook stdout/stderr read into memory with no size bound — hooks.rs:536-537.**
`String::from_utf8_lossy(&out.stdout)` buffers whatever the hook printed before parse_hook_output scans it; a post-hook that cats/tails a large file balloons memory then string-scans it as potential JSON. Tool-result side truncates at RESULT_SNIPPET_CHARS (4,000); hook output has no equivalent. Fix: cap collected output (~1 MiB via bounded take) before UTF-8 conversion.

Checked and found sound: webhook listener loopback-only with constant-time secret comparison and pre-auth read budgets; cron due-math (strictly-after next_fire, finalize-time last_run_at advance, event-vs-cron clock split) — no double-fire path after sleep/resume or app+sidecar overlap (create_new lock file with live-PID staleness arbitrates cross-process); `${tool_input.*}` substitution is exec-form and single-pass (no shell injection); frontmatter parser CRLF/multibyte slicing panic-free; `validate_repo_relative` correctly blocks absolute/`..` renderer paths; branch/worktree names leading-dash guarded; GitHub PAT never reaches logs or URLs; `run_one_shot_chat` carries a 120s HTTP timeout.
