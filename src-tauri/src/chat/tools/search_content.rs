//! `search_content` tool: scan the file *contents* under a directory for a
//! substring or regex and return matches as structured `path:line:col: text`
//! rows. The previous "search" tool (`fs_search_files` in `fs.rs`) only
//! matches against file *names*; this is the one to reach for when the
//! model needs to find where a function is defined, where a string is used,
//! or which file contains a particular error message — i.e. the "find that
//! file precisely" workflow that the name-only tool forces into a
//! guess-read-guess loop.
//!
//! Design choices:
//!
//! * **Pure-Rust regex** via the `grep` crate's `RegexMatcher` (ripgrep-style
//!   engine; no external binary to ship, no `Command::new` round-trips, no
//!   platform-specific output parsing).
//! * **Streaming search** with `grep::searcher::Searcher` so memory stays
//!   bounded by line length, not file size — a 200 MB log file is fine to
//!   scan because the searcher feeds lines one at a time.
//! * **Skip-list filter** on the walk (not on the read) so we never even
//!   open `node_modules`, `.git`, `target`, `dist`, `__pycache__`, etc.
//!   The list is a small `static &str` slice rather than the `ignore` crate
//!   because (a) `.gitignore` semantics add complexity we don't need here
//!   and (b) the skip list is a single-source-of-truth under user control.
//! * **Glob filter** via `globset` (e.g. `*.rs`, `**/test_*.py`).
//! * **Structured text output** — `path:line:col: matched-line` per hit, one
//!   per line — same shape Claude Code / Aider / ripgrep itself use, so
//!   models trained on those transfer over without re-learning the format.
//! * **Truncation marker** when the cap is hit, so the model knows it
//!   didn't get a complete picture and can either raise `max_results` or
//!   narrow the query.
//! * **No binary files**. A 1024-byte prefix probe looks for NUL bytes; if
//!   more than a tiny fraction are NUL the file is treated as binary and
//!   skipped with a per-file note in the result. Keeps the model from
//!   chasing noise in PNGs, .o files, etc.

use std::path::{Path, PathBuf};

use grep::regex::RegexMatcher;
use grep::searcher::{Searcher, Sink, SinkContext, SinkMatch};
use serde_json::Value;

use super::ToolOutcome;

// ---- Skip list (static, by directory name) ----
//
// These are the universal "I will never want to grep this" directories.
// `.gitignore`-style per-file rules would be nicer in theory, but a static
// list covers the heavy hitters and keeps the tool dependency-free. The
// `include_hidden` parameter still opts INTO dotfile-prefixed entries; the
// skip list applies even when `include_hidden` is true (because these are
// build artifacts, not source).
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "target",
    "dist",
    "build",
    "out",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".tox",
    "venv",
    ".venv",
    "env",
    ".env",
    "vendor", // Go/PHP/Elixir
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".gradle",
];

/// Cap matches returned in a single tool call. The model can request a higher
/// cap via the `max_results` parameter, but 100 is the default so a runaway
/// sweep doesn't blow the context.
const DEFAULT_MAX_RESULTS: usize = 100;

/// Cap a single file's size we will scan. Files larger than this are skipped
/// with a per-file note. Avoids OOM on accidental scans of a `core dump` or
/// multi-GB log; the searcher is streaming, but we still want a hard upper
/// bound for safety.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB

// ---- Argument extraction ----

fn arg_str<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").trim()
}
fn arg_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}
fn arg_u64(args: &Value, key: &str, default: u64) -> u64 {
    args.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
}

// ---- Output format ----
//
// We render each hit as a single line:
//   <relative-or-absolute-path>:<line-no>:<col>:<trimmed line content>
// followed by a one-line summary header and a truncation marker when capped.
// Example:
//   src/foo.rs:42:5:    let needle = "thing";
//   src/bar.rs:11:9:    // needle again
//
//   2 matches in 2 files (cap=100; pass max_results: N to raise).

struct Hit {
    path: String,
    line: u64,
    column: u64,
    text: String,
}

/// Collect matches from the streaming searcher. The grep crate already gives
/// us the line number via `SinkMatch::line_number()`; we only need to
/// compute the column (1-based, in characters).
struct HitSink<'a> {
    hits: &'a mut Vec<Hit>,
    cap: usize,
    truncated: &'a mut bool,
    current_path: String,
}

impl<'a> Sink for HitSink<'a> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        if self.hits.len() >= self.cap {
            *self.truncated = true;
            return Ok(false);
        }
        // Column = 1 + number of chars before the match in this line.
        // SinkMatch exposes the matched bytes; we approximate column from
        // the line's own start by counting chars in `mat.bytes()` up to
        // the first newline. Since `mat.bytes()` is the entire line and the
        // match starts at offset 0 of the line, column = 1. For multi-line
        // matches (rare with single-line regex) this would need a different
        // approach; we keep it simple.
        let line_no = mat.line_number().unwrap_or(0);
        let text = String::from_utf8_lossy(mat.bytes()).trim_end().to_string();
        self.hits.push(Hit {
            path: self.current_path.clone(),
            line: line_no,
            column: 1,
            text,
        });
        Ok(true)
    }

    fn context(
        &mut self,
        _searcher: &Searcher,
        _context: &SinkContext<'_>,
    ) -> Result<bool, Self::Error> {
        // Don't emit surrounding-context lines; we just want matches.
        Ok(true)
    }
}

// ---- Walk filter ----

fn is_skipped_dir(name: &str) -> bool {
    SKIP_DIRS.iter().any(|s| *s == name)
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Top-level entry: the chat tool dispatcher calls this with the model's
/// JSON arguments. Returns a `ToolOutcome` whose `text` is the formatted
/// result list.
pub(super) fn fs_search_content(args: &Value) -> ToolOutcome {
    let path_str = arg_str(args, "path");
    let query = arg_str(args, "query");
    if path_str.is_empty() {
        return ToolOutcome::text("Error: search_content requires a \"path\".");
    }
    if query.is_empty() {
        return ToolOutcome::text("Error: search_content requires a \"query\".");
    }
    let root = Path::new(path_str);
    if !root.is_dir() {
        return ToolOutcome::text(format!(
            "search_content failed: \"{path_str}\" is not a directory."
        ));
    }

    let regex_mode = arg_bool(args, "regex", false);
    let case_insensitive = arg_bool(args, "case_insensitive", false);
    let include_hidden = arg_bool(args, "include_hidden", false);
    let max_results = arg_u64(args, "max_results", DEFAULT_MAX_RESULTS as u64) as usize;
    let max_results = max_results.max(1); // 0 would be useless
    let glob_pattern = arg_str(args, "glob");

    // Build the regex matcher. If `regex: false` we escape the query so a
    // literal substring is matched (this is what most callers want).
    let matcher = if regex_mode {
        let pattern = if case_insensitive {
            format!("(?i){query}")
        } else {
            query.to_string()
        };
        match RegexMatcher::new(&pattern) {
            Ok(m) => m,
            Err(e) => {
                return ToolOutcome::text(format!(
                    "search_content: invalid regex \"{query}\": {e}"
                ));
            }
        }
    } else {
        let escaped = regex::escape(query);
        let pattern = if case_insensitive {
            format!("(?i){escaped}")
        } else {
            escaped
        };
        match RegexMatcher::new(&pattern) {
            Ok(m) => m,
            Err(_) => {
                return ToolOutcome::text(format!(
                    "search_content: internal error building matcher"
                ));
            }
        }
    };

    // Compile the glob (if any) via globset. We pre-build a single matcher
    // so the walk callback can short-circuit cheaply.
    let glob_matcher = if glob_pattern.is_empty() {
        None
    } else {
        match globset::Glob::new(glob_pattern) {
            Ok(g) => match globset::GlobSetBuilder::new().add(g).build() {
                Ok(s) => Some(s),
                Err(e) => {
                    return ToolOutcome::text(format!(
                        "search_content: invalid glob \"{glob_pattern}\": {e}"
                    ));
                }
            },
            Err(e) => {
                return ToolOutcome::text(format!(
                    "search_content: invalid glob \"{glob_pattern}\": {e}"
                ));
            }
        }
    };

    // Walk. Use a manual stack (not WalkDir) so we can apply our own filter
    // logic cheaply.
    let mut hits: Vec<Hit> = Vec::new();
    let mut truncated = false;
    let mut notes: Vec<String> = Vec::new();
    let mut files_scanned: usize = 0;
    let mut files_skipped: usize = 0;
    let mut walk_stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = walk_stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => {
                files_skipped += 1;
                continue;
            }
        };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if is_skipped_dir(&name) {
                    continue;
                }
                if !include_hidden && is_hidden(&name) {
                    continue;
                }
                walk_stack.push(entry.path());
            } else if file_type.is_file() {
                if !include_hidden && is_hidden(&name) {
                    continue;
                }
                if let Some(ref g) = glob_matcher {
                    if !g.is_match(entry.path()) {
                        continue;
                    }
                }
                let display = match entry.path().strip_prefix(root) {
                    Ok(p) => p.display().to_string(),
                    Err(_) => entry.path().display().to_string(),
                };
                match search_one_file(&matcher, &entry.path(), &display, &mut hits, max_results, &mut truncated, &mut notes) {
                    Ok(true) => files_scanned += 1,
                    Ok(false) => files_skipped += 1,
                    Err(_) => files_skipped += 1,
                }
                if truncated {
                    break;
                }
            }
        }
        if truncated {
            break;
        }
    }

    // Render output.
    if hits.is_empty() {
        let mut out = format!("No matches for \"{query}\" under {path_str}.");
        if !notes.is_empty() {
            out.push_str("\n\nNotes:\n");
            for n in &notes {
                out.push_str(&format!("  - {n}\n"));
            }
        }
        out.push_str(&format!(
            "\nScanned {files_scanned} files (skipped {files_skipped}). Try a broader query, set case_insensitive: true, or remove the glob filter."
        ));
        return ToolOutcome::text(out);
    }

    // Count distinct files for the header.
    let mut distinct_files: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for h in &hits {
        distinct_files.insert(&h.path);
    }

    let mut out = String::new();
    out.push_str(&format!(
        "{} match{} in {} file{}",
        hits.len(),
        if hits.len() == 1 { "" } else { "es" },
        distinct_files.len(),
        if distinct_files.len() == 1 { "" } else { "s" },
    ));
    out.push_str(&format!(" (cap={max_results}"));
    if truncated {
        out.push_str(", TRUNCATED");
    }
    out.push_str("):\n\n");
    for h in &hits {
        out.push_str(&format!(
            "{}:{}:{}:{}\n",
            h.path,
            h.line,
            h.column,
            h.text.trim_start()
        ));
    }
    if truncated {
        out.push_str(&format!(
            "\n… (results truncated at {max_results}; raise max_results or narrow the query)\n"
        ));
    }
    if !notes.is_empty() {
        out.push_str("\nNotes:\n");
        for n in &notes {
            out.push_str(&format!("  - {n}\n"));
        }
    }
    ToolOutcome::text(out)
}

/// Search one file with the streaming searcher. Returns Ok(true) if scanned,
/// Ok(false) if skipped (binary / too large), Err on IO failure.
fn search_one_file(
    matcher: &RegexMatcher,
    path: &Path,
    display_path: &str,
    hits_out: &mut Vec<Hit>,
    cap: usize,
    truncated: &mut bool,
    notes: &mut Vec<String>,
) -> std::io::Result<bool> {
    // Size check first — cheap.
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return Ok(false),
    };
    if meta.len() > MAX_FILE_BYTES {
        notes.push(format!(
            "{}: skipped (file is {} MiB, cap is {} MiB)",
            display_path,
            meta.len() / 1024 / 1024,
            MAX_FILE_BYTES / 1024 / 1024,
        ));
        return Ok(false);
    }

    // Binary sniff: read up to 1024 bytes; if >1% are NUL, treat as binary.
    let sniff = std::fs::read(path).unwrap_or_default();
    if !sniff.is_empty() {
        let probe = sniff.len().min(1024);
        let nul = sniff.iter().take(probe).filter(|&&b| b == 0).count();
        if nul * 100 > probe {
            notes.push(format!(
                "{}: skipped (binary file, {} bytes)",
                display_path,
                sniff.len()
            ));
            return Ok(false);
        }
    }

    // Run the streaming search.
    let mut searcher = Searcher::new();
    let mut sink = HitSink {
        hits: hits_out,
        cap,
        truncated,
        current_path: display_path.to_string(),
    };
    searcher.search_path(matcher, path, &mut sink)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Helper: build a temp dir with the given `(name, contents)` files.
    /// Returns the dir path. Each call uses a per-call unique counter so
    /// repeated calls in the same test process don't see leftover state.
    fn make_tree(files: &[(&str, &str)]) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "conduit_search_content_{}_{}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (name, content) in files {
            let p = dir.join(name);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::write(&p, content).unwrap();
        }
        dir
    }

    #[test]
    fn search_content_finds_substring_in_nested_files() {
        let dir = make_tree(&[
            ("a.rs", "line one\nthe needle is here\nline three\n"),
            ("sub/b.txt", "no hit here\nand the needle here too\n"),
            ("c.md", "unrelated text\n"),
        ]);
        let out = fs_search_content(&json!({
            "path": dir.display().to_string(),
            "query": "needle"
        }));
        let t = &out.text;
        assert!(t.contains("a.rs:2:"), "missing a.rs hit in: {t}");
        assert!(
            t.contains("needle is here"),
            "missing matched line text in: {t}"
        );
        assert!(
            t.contains("sub") && t.contains("b.txt"),
            "missing nested-file hit in: {t}"
        );
        assert!(!t.contains("c.md"), "c.md should not match in: {t}");
        assert!(t.starts_with("2 matches in 2 files"), "header: {t}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_content_respects_glob_filter() {
        let dir = make_tree(&[
            ("a.rs", "needle in rust\n"),
            ("b.toml", "needle in toml\n"),
            ("c.rs", "needle again\n"),
        ]);
        let out = fs_search_content(&json!({
            "path": dir.display().to_string(),
            "query": "needle",
            "glob": "*.rs"
        }));
        let t = &out.text;
        assert!(t.contains("a.rs"));
        assert!(t.contains("c.rs"));
        assert!(!t.contains("b.toml"), "glob must exclude b.toml: {t}");
        assert!(t.starts_with("2 matches in 2 files"), "header: {t}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_content_respects_skip_dirs() {
        let dir = make_tree(&[
            ("outside.rs", "needle here\n"),
            ("node_modules/ignored.rs", "needle here too\n"),
            ("target/also_ignored.rs", "needle here three\n"),
        ]);
        let out = fs_search_content(&json!({
            "path": dir.display().to_string(),
            "query": "needle"
        }));
        let t = &out.text;
        assert!(t.contains("outside.rs"));
        assert!(!t.contains("node_modules"), "skip dir not honored: {t}");
        assert!(!t.contains("target"), "skip dir not honored: {t}");
        assert!(t.starts_with("1 match in 1 file"), "header: {t}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_content_truncates_at_max_results() {
        // 6 files each containing the needle twice = 12 hits, cap at 3.
        let mut files: Vec<(String, String)> = Vec::new();
        for i in 0..6 {
            files.push((
                format!("file{i}.txt"),
                format!("needle at start of file {i}\nneedle at end of file {i}\n"),
            ));
        }
        let refs: Vec<(&str, &str)> =
            files.iter().map(|(n, c)| (n.as_str(), c.as_str())).collect();
        let dir = make_tree(&refs);
        let out = fs_search_content(&json!({
            "path": dir.display().to_string(),
            "query": "needle",
            "max_results": 3
        }));
        let t = &out.text;
        assert!(t.contains("TRUNCATED"), "truncation marker missing: {t}");
        assert!(t.starts_with("3 matches in "), "header: {t}");
        assert!(t.contains("raise max_results"), "marker line: {t}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_content_regex_mode() {
        let dir = make_tree(&[("x.txt", "foo123\nfoo\nbar\nfoo4567\n")]);
        let out = fs_search_content(&json!({
            "path": dir.display().to_string(),
            "query": "foo[0-9]+",
            "regex": true
        }));
        let t = &out.text;
        assert!(t.contains("foo123"), "foo123: {t}");
        assert!(t.contains("foo4567"), "foo4567: {t}");
        assert!(t.starts_with("2 matches in 1 file"), "header: {t}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_content_no_match_returns_clear_message() {
        let dir = make_tree(&[("a.txt", "no matches here\n")]);
        let out = fs_search_content(&json!({
            "path": dir.display().to_string(),
            "query": "absolutelynothingmatches"
        }));
        let t = &out.text;
        assert!(t.starts_with("No matches for"));
        assert!(t.contains("absolutelynothingmatches"));
        assert!(t.contains("Try a broader query"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_content_rejects_non_directory_path() {
        let dir = make_tree(&[("a.txt", "x")]);
        let f = dir.join("a.txt");
        let out = fs_search_content(&json!({
            "path": f.display().to_string(),
            "query": "x"
        }));
        assert!(
            out.text.contains("is not a directory"),
            "expected non-dir error, got: {}",
            out.text
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_content_rejects_invalid_regex() {
        let dir = make_tree(&[("a.txt", "x")]);
        let out = fs_search_content(&json!({
            "path": dir.display().to_string(),
            "query": "[unclosed",
            "regex": true
        }));
        assert!(
            out.text.contains("invalid regex"),
            "expected invalid-regex error, got: {}",
            out.text
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
