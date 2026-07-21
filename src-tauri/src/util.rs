//! Small cross-cutting utilities.

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
}
