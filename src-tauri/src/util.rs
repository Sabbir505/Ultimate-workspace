//! Small cross-cutting utilities.

/// Char-safe prefix truncation: take at most `max` CHARACTERS. Never slices on
/// a byte boundary, so a multibyte UTF-8 sequence (CJK, emoji) straddling the
/// cut can't panic — the failure mode of `&s[..n]` on provider/model-controlled
/// text (error bodies, shell output, bridge returns).
pub fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Char-safe suffix truncation: keep the LAST `max` characters (used for
/// tail-capping long shell output). Same panic-safety rationale as
/// `truncate_chars`.
pub fn tail_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    s.chars().skip(count - max).collect()
}

/// Strip the Windows extended-length path prefix (`\\?\`) that
/// `std::fs::canonicalize` produces. cmd.exe — and therefore any pty spawned
/// through our `.cmd`-shim wrapper (see `harness_adapters::resolve_for_spawn`)
/// — rejects such paths as "UNC paths are not supported" and silently falls
/// back to the Windows directory as cwd, which breaks agent sessions opened
/// on a project folder. On non-Windows this is a no-op passthrough.
pub fn strip_unc_prefix(path: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(rest) = path.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    path.to_string()
}

/// The user's home directory: `USERPROFILE` (Windows) first, then `HOME`
/// (POSIX). Shared by the harness adapters and the installed-skills scanner
/// so the resolution rule (USERPROFILE wins on Windows, where both can be set
/// by MSYS/git-bash) lives in exactly one place. Returns `None` if neither is
/// set — callers must tolerate that (rare, but possible in stripped envs).
pub fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

/// Containment check: is `path` equal to or nested under `prefix`?
///
/// Component-wise (via `Path::starts_with`) and case-insensitive on Windows.
/// NEVER implement this as a lowercase string `starts_with`: a raw string
/// prefix match lets a same-prefix SIBLING pass — with allowlisted root
/// `D:\proj\app`, the path `D:\proj\app-old\secret` string-matches but is not
/// under the root. This is the SECURITY boundary for `read_file_text`, the
/// git commands, and model deletion, so the segment boundary is load-bearing.
///
/// Both sides should already be filesystem-canonicalized by the caller (this
/// helper is lexicographic; it does not resolve symlinks or `..`).
pub fn path_starts_with_ci(path: &std::path::Path, prefix: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        if path.starts_with(prefix) {
            return true;
        }
        // Case-insensitive fallback, still component-wise: lowercase both
        // sides, then compare whole path components (not a string prefix).
        let lowered_path = path.to_string_lossy().to_lowercase();
        let lowered_prefix = prefix.to_string_lossy().to_lowercase();
        std::path::Path::new(&lowered_path).starts_with(std::path::Path::new(&lowered_prefix))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(prefix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn strips_extended_length_prefix() {
        assert_eq!(
            strip_unc_prefix(r"\\?\D:\Projects\foo"),
            r"D:\Projects\foo"
        );
        // Ordinary paths pass through untouched.
        assert_eq!(strip_unc_prefix(r"D:\Projects\foo"), r"D:\Projects\foo");
        // A real UNC share (\\server\share) must NOT be mangled.
        assert_eq!(
            strip_unc_prefix(r"\\server\share\foo"),
            r"\\server\share\foo"
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn passthrough_on_posix() {
        assert_eq!(strip_unc_prefix("/home/u/proj"), "/home/u/proj");
    }

    #[test]
    #[cfg(windows)]
    fn ci_containment_requires_segment_boundary() {
        use std::path::Path;
        // Case-insensitive match of nested paths.
        assert!(crate::util::path_starts_with_ci(
            Path::new(r"D:\proj\app\src\main.rs"),
            Path::new(r"d:\PROJ\app"),
        ));
        // The root itself matches.
        assert!(crate::util::path_starts_with_ci(
            Path::new(r"D:\proj\app"),
            Path::new(r"d:\proj\app"),
        ));
        // Same-prefix SIBLINGS must NOT match (the load-bearing case).
        assert!(!crate::util::path_starts_with_ci(
            Path::new(r"D:\proj\app-old\x"),
            Path::new(r"D:\proj\app"),
        ));
        assert!(!crate::util::path_starts_with_ci(
            Path::new(r"D:\proj\apple\x"),
            Path::new(r"D:\proj\app"),
        ));
    }

    #[test]
    fn truncate_chars_never_splits_multibyte() {
        // 3-byte chars: byte 500 would land mid-codepoint.
        let cjk = "日".repeat(400);
        let out = truncate_chars(&cjk, 200);
        assert_eq!(out.chars().count(), 200);
        assert_eq!(out, "日".repeat(200));
        // Short strings pass through whole.
        assert_eq!(truncate_chars("héllo", 10), "héllo");
        // Emoji (4 bytes) at the cut: take lands exactly on the boundary.
        let emoji = "a".repeat(498) + &"🎉".repeat(10);
        let out = truncate_chars(&emoji, 499);
        assert_eq!(out.chars().count(), 499);
        assert_eq!(out.chars().last(), Some('🎉'));
    }

    #[test]
    fn tail_chars_keeps_suffix_on_char_boundary() {
        let s = "x".repeat(900) + &"語".repeat(50);
        let out = tail_chars(&s, 60);
        assert_eq!(out.chars().count(), 60);
        assert!(out.starts_with('x'));
        assert!(out.ends_with('語'));
        // At/below the cap: verbatim.
        assert_eq!(tail_chars("short", 10), "short");
    }
}
