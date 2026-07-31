//! Filesystem tools: `list_directory`, `read_file`, `search_files`
//! (read-only, auto-run in every permission mode) and `write_file`,
//! `edit_file`, `delete_file`, `move_file`, `copy_file` (mutating, gated
//! by the central `permission::check_permission` in the caller before they
//! run). They operate on the real absolute paths the model passes — no
//! traversal tricks, no shell-out — and report errors as plain text fed back
//! to the model so it can self-correct.

use serde_json::Value;

use super::ToolOutcome;

// =====================
// Filesystem tool impls
// =====================
//
// These operate on the real absolute paths the model passes. The permission
// gate (auto-run vs. approval card) is enforced by the caller; these branches
// only run for actions that have been authorized. They are intentionally
// straightforward — no traversal tricks, no shell-out — and report errors as
// plain text fed back to the model so it can self-correct.

/// Cap text returned to the model so a huge file doesn't blow the context.
const FS_READ_MAX: usize = 32_000;

/// Pull the `path` (or `src`/`dest`) string args out of a tool call. Returns
/// the trimmed string or "" when absent — callers check and emit an error.
fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// List one level of a directory: sorted entries with a trailing `/` for dirs.
pub(super) fn fs_list_directory(args: &Value) -> ToolOutcome {
    let path = arg_str(args, "path");
    if path.is_empty() {
        return ToolOutcome::text("Error: list_directory requires a \"path\".");
    }
    let entries = match std::fs::read_dir(&path) {
        Ok(e) => e,
        Err(e) => return ToolOutcome::text(format!("list_directory failed: {e}")),
    };
    let mut items: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        items.push(if is_dir { format!("{name}/") } else { name });
    }
    items.sort();
    if items.is_empty() {
        return ToolOutcome::text(format!("(empty directory) {path}"));
    }
    ToolOutcome::text(items.join("\n"))
}

/// Read a file's text contents, length-capped.
pub(super) fn fs_read_file(args: &Value) -> ToolOutcome {
    let path = arg_str(args, "path");
    if path.is_empty() {
        return ToolOutcome::text("Error: read_file requires a \"path\".");
    }
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => return ToolOutcome::text(format!("read_file failed: {e}")),
    };
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    let truncated = text.len() > FS_READ_MAX;
    if truncated {
        let mut cut = FS_READ_MAX;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n… (truncated)");
    }
    ToolOutcome::text(text)
}

/// Recursively find files whose name contains the query substring.
pub(super) fn fs_search_files(args: &Value) -> ToolOutcome {
    let path = arg_str(args, "path");
    let query = arg_str(args, "query");
    if path.is_empty() || query.is_empty() {
        return ToolOutcome::text("Error: search_files requires \"path\" and \"query\".");
    }
    let needle = query.to_ascii_lowercase();
    let mut matches: Vec<String> = Vec::new();
    let mut stack = vec![std::path::PathBuf::from(&path)];
    const MAX_RESULTS: usize = 100;
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            if matches.len() >= MAX_RESULTS {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.to_ascii_lowercase().contains(&needle) {
                let p = entry.path().display().to_string();
                matches.push(p);
            }
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(entry.path());
            }
        }
    }
    if matches.is_empty() {
        return ToolOutcome::text(format!("No files matching \"{query}\" under {path}."));
    }
    ToolOutcome::text(matches.join("\n"))
}

/// Create or overwrite a file, creating parent directories as needed.
pub(super) fn fs_write_file(args: &Value) -> ToolOutcome {
    let path = arg_str(args, "path");
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return ToolOutcome::text("Error: write_file requires a \"path\".");
    }
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ToolOutcome::text(format!("write_file failed to create dirs: {e}"));
            }
        }
    }
    match std::fs::write(p, content) {
        Ok(_) => ToolOutcome::text(format!("Wrote {} bytes to {path}.", content.len())),
        Err(e) => ToolOutcome::text(format!("write_file failed: {e}")),
    }
}

/// Edit a file: find/replace the first occurrence, or append.
///
/// Safety: if `find` matches more than once in the file, the edit is REJECTED
/// by default — the model gets back a line-numbered list of all matches so it
/// can disambiguate instead of silently editing the wrong place. To proceed
/// in a multi-match case, the model must pass either:
///   * `all_occurrences: true`  — replace every match (bulk refactor), OR
///   * `expected_matches: N`    — confirm the count is N before replacing.
///
/// Single-match and zero-match paths are unchanged from the prior behavior.
pub(super) fn fs_edit_file(args: &Value) -> ToolOutcome {
    let path = arg_str(args, "path");
    if path.is_empty() {
        return ToolOutcome::text("Error: edit_file requires a \"path\".");
    }
    let p = std::path::Path::new(&path);
    let mut text = match std::fs::read_to_string(p) {
        Ok(t) => t,
        Err(e) => return ToolOutcome::text(format!("edit_file failed to read: {e}")),
    };
    if let Some(append) = args.get("append").and_then(|v| v.as_str()) {
        text.push_str(append);
    } else {
        let find = args.get("find").and_then(|v| v.as_str()).unwrap_or("");
        let replace = args.get("replace").and_then(|v| v.as_str()).unwrap_or("");
        if find.is_empty() {
            return ToolOutcome::text("Error: edit_file requires either \"append\" or a non-empty \"find\".");
        }
        // Count every match. `match_indices` gives us both the byte offset and
        // the matched substring, so we can build a "lines 12, 45, 102"
        // conflict report.
        let occurrences: Vec<(usize, &str)> = text.match_indices(find).collect();
        if occurrences.is_empty() {
            return ToolOutcome::text(format!(
                "edit_file: \"find\" substring not found in {path}."
            ));
        }
        let all_occurrences = args
            .get("all_occurrences")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let expected_matches: Option<usize> = args
            .get("expected_matches")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize);
        if occurrences.len() > 1 && !all_occurrences {
            // Honor expected_matches = N exactly: the model has confirmed it
            // really meant all of them.
            let allowed = match expected_matches {
                Some(n) if n == occurrences.len() => true,
                _ => false,
            };
            if !allowed {
                // Build a line-numbered conflict list so the model can pick
                // a unique chunk (or set expected_matches / all_occurrences).
                let lines: Vec<String> = occurrences
                    .iter()
                    .map(|(byte_off, _)| {
                        // Convert byte offset → 1-based line number.
                        let before = &text[..*byte_off];
                        let line = before.bytes().filter(|&b| b == b'\n').count() + 1;
                        format!("line {line}")
                    })
                    .collect();
                return ToolOutcome::text(format!(
                    "edit_file: \"find\" matched {} times in {path} ({}). \
                     Refine the \"find\" string to be unique to one location, \
                     or pass `all_occurrences: true` to replace all of them, \
                     or pass `expected_matches: {}` to confirm you meant all of them.",
                    occurrences.len(),
                    lines.join(", "),
                    occurrences.len(),
                ));
            }
        }
        // We either have a single match, or the model explicitly opted in.
        if all_occurrences || occurrences.len() > 1 {
            // Single read-modify-write pass: replace every occurrence
            // left-to-right. `replacen` with count = all replaces
            // non-overlapping matches in one shot. This branch is taken for:
            //   (a) all_occurrences = true (explicit bulk rename), or
            //   (b) occurrences.len() > 1 AND expected_matches == N
            //       (model confirmed it really meant all of them).
            text = text.replacen(find, replace, occurrences.len());
        } else {
            // Single match, the only remaining path.
            let idx = occurrences[0].0;
            let mut out = String::with_capacity(text.len() + replace.len());
            out.push_str(&text[..idx]);
            out.push_str(replace);
            out.push_str(&text[idx + find.len()..]);
            text = out;
        }
    }
    match std::fs::write(p, &text) {
        Ok(_) => ToolOutcome::text(format!("Edited {path} (now {} bytes).", text.len())),
        Err(e) => ToolOutcome::text(format!("edit_file failed to write: {e}")),
    }
}

/// Delete a file or an empty directory.
pub(super) fn fs_delete_file(args: &Value) -> ToolOutcome {
    let path = arg_str(args, "path");
    if path.is_empty() {
        return ToolOutcome::text("Error: delete_file requires a \"path\".");
    }
    let p = std::path::Path::new(&path);
    let result = if p.is_dir() {
        std::fs::remove_dir(p) // only empty dirs — non-empty is an error, by design
    } else {
        std::fs::remove_file(p)
    };
    match result {
        Ok(_) => ToolOutcome::text(format!("Deleted {path}.")),
        Err(e) => ToolOutcome::text(format!("delete_file failed: {e}")),
    }
}

/// Move/rename a file or directory.
pub(super) fn fs_move_file(args: &Value) -> ToolOutcome {
    let src = arg_str(args, "src");
    let dest = arg_str(args, "dest");
    if src.is_empty() || dest.is_empty() {
        return ToolOutcome::text("Error: move_file requires \"src\" and \"dest\".");
    }
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ToolOutcome::text(format!("move_file failed to create dirs: {e}"));
            }
        }
    }
    match std::fs::rename(&src, &dest) {
        Ok(_) => ToolOutcome::text(format!("Moved {src} → {dest}.")),
        Err(e) => ToolOutcome::text(format!("move_file failed: {e}")),
    }
}

/// Copy a file (not a directory — directories error with a clear message).
pub(super) fn fs_copy_file(args: &Value) -> ToolOutcome {
    let src = arg_str(args, "src");
    let dest = arg_str(args, "dest");
    if src.is_empty() || dest.is_empty() {
        return ToolOutcome::text("Error: copy_file requires \"src\" and \"dest\".");
    }
    if std::path::Path::new(&src).is_dir() {
        return ToolOutcome::text("copy_file only supports files, not directories (use move_file or write_file).");
    }
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ToolOutcome::text(format!("copy_file failed to create dirs: {e}"));
            }
        }
    }
    match std::fs::copy(&src, &dest) {
        Ok(n) => ToolOutcome::text(format!("Copied {src} → {dest} ({n} bytes).")),
        Err(e) => ToolOutcome::text(format!("copy_file failed: {e}")),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fs_write_read_edit_round_trip() {
        let dir = std::env::temp_dir().join(format!("conduit_fs_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("sub").join("hello.txt");

        // write_file creates parent dirs + writes content.
        let out = fs_write_file(&json!({ "path": path.display().to_string(), "content": "hello world" }));
        assert!(out.text.contains("Wrote"), "{}", out.text);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello world");

        // read_file returns the contents.
        let out = fs_read_file(&json!({ "path": path.display().to_string() }));
        assert!(out.text.contains("hello world"));

        // edit_file find/replace.
        let out = fs_edit_file(&json!({
            "path": path.display().to_string(),
            "find": "world",
            "replace": "there"
        }));
        assert!(out.text.contains("Edited"), "{}", out.text);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello there");

        // edit_file append.
        let out = fs_edit_file(&json!({ "path": path.display().to_string(), "append": "!" }));
        assert!(out.text.contains("Edited"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello there!");

        // list_directory lists the parent (contains hello.txt).
        let out = fs_list_directory(&json!({ "path": dir.join("sub").display().to_string() }));
        assert!(out.text.contains("hello.txt"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fs_copy_and_move() {
        let dir = std::env::temp_dir().join(format!("conduit_fs_cm_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.txt");
        std::fs::write(&src, "abc").unwrap();

        // copy_file
        let dest = dir.join("b.txt");
        let out = fs_copy_file(&json!({ "src": src.display().to_string(), "dest": dest.display().to_string() }));
        assert!(out.text.contains("Copied"), "{}", out.text);
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "abc");
        assert!(src.exists(), "source still present after copy");

        // move_file
        let moved = dir.join("moved.txt");
        let out = fs_move_file(&json!({ "src": src.display().to_string(), "dest": moved.display().to_string() }));
        assert!(out.text.contains("Moved"), "{}", out.text);
        assert!(!src.exists(), "source gone after move");
        assert_eq!(std::fs::read_to_string(&moved).unwrap(), "abc");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fs_delete_file_removes_file() {
        let dir = std::env::temp_dir().join(format!("conduit_fs_del_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("gone.txt");
        std::fs::write(&f, "x").unwrap();
        let out = fs_delete_file(&json!({ "path": f.display().to_string() }));
        assert!(out.text.contains("Deleted"), "{}", out.text);
        assert!(!f.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fs_search_files_finds_by_substring() {
        let dir = std::env::temp_dir().join(format!("conduit_fs_search_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("report_q1.md"), "x").unwrap();
        std::fs::write(dir.join("notes.txt"), "y").unwrap();
        let out = fs_search_files(&json!({ "path": dir.display().to_string(), "query": "report" }));
        assert!(out.text.contains("report_q1.md"), "{}", out.text);
        assert!(!out.text.contains("notes.txt"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- edit_file uniqueness / safety tests ----
    //
    // The default find/replace is now strict: a multi-match is rejected
    // unless the model opts in via all_occurrences or expected_matches.
    // These tests pin down that behavior so future changes don't silently
    // regress to "first match wins" (which used to mis-edit comments).

    fn two_duplicate_lines_file(dir: &std::path::Path) -> std::path::PathBuf {
        let f = dir.join("dup.txt");
        std::fs::write(
            &f,
            "alpha\nthe needle is here\nbeta\nthe needle is here\ngamma\n",
        )
        .unwrap();
        f
    }

    #[test]
    fn edit_file_rejects_ambiguous_find_with_line_numbers() {
        let dir = std::env::temp_dir().join(format!("conduit_edit_amb_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = two_duplicate_lines_file(&dir);

        // No all_occurrences / expected_matches → must error and not write.
        let out = fs_edit_file(&json!({
            "path": f.display().to_string(),
            "find": "the needle is here",
            "replace": "REPLACED"
        }));
        assert!(out.text.contains("matched 2 times"), "got: {}", out.text);
        assert!(out.text.contains("line 2") && out.text.contains("line 4"),
            "expected both line numbers in conflict report, got: {}", out.text);
        // File is unchanged.
        let after = std::fs::read_to_string(&f).unwrap();
        assert_eq!(after, "alpha\nthe needle is here\nbeta\nthe needle is here\ngamma\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_file_all_occurrences_replaces_every_match() {
        let dir = std::env::temp_dir().join(format!("conduit_edit_all_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = two_duplicate_lines_file(&dir);

        let out = fs_edit_file(&json!({
            "path": f.display().to_string(),
            "find": "the needle is here",
            "replace": "X",
            "all_occurrences": true
        }));
        assert!(out.text.contains("Edited"), "got: {}", out.text);
        let after = std::fs::read_to_string(&f).unwrap();
        assert_eq!(after, "alpha\nX\nbeta\nX\ngamma\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_file_expected_matches_disambiguates() {
        let dir = std::env::temp_dir().join(format!("conduit_edit_exp_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = two_duplicate_lines_file(&dir);

        // Confirm "yes, I meant both" — the edit goes through.
        let out = fs_edit_file(&json!({
            "path": f.display().to_string(),
            "find": "the needle is here",
            "replace": "X",
            "expected_matches": 2
        }));
        assert!(out.text.contains("Edited"), "got: {}", out.text);
        let after = std::fs::read_to_string(&f).unwrap();
        assert_eq!(after, "alpha\nX\nbeta\nX\ngamma\n");

        // A wrong expected_matches is itself a conflict: build a fresh
        // file (the previous edit replaced all the needles, so a 2nd
        // call would now see 0 matches) and pass expected_matches: 3.
        let f2 = two_duplicate_lines_file(&dir);
        let out = fs_edit_file(&json!({
            "path": f2.display().to_string(),
            "find": "the needle is here",
            "replace": "Y",
            "expected_matches": 3
        }));
        assert!(out.text.contains("matched 2 times"), "got: {}", out.text);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_file_unique_find_still_works() {
        // Regression: a single-match find (the old happy path) is unchanged.
        let dir = std::env::temp_dir().join(format!("conduit_edit_ok_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("ok.txt");
        std::fs::write(&f, "alpha\nbeta\ngamma\n").unwrap();

        let out = fs_edit_file(&json!({
            "path": f.display().to_string(),
            "find": "beta",
            "replace": "BETA"
        }));
        assert!(out.text.contains("Edited"), "got: {}", out.text);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "alpha\nBETA\ngamma\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
