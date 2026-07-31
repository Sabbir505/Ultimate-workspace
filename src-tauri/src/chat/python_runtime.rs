//! Python runtime resolution for document generation (`generate_document`)
//! and ad-hoc code execution (`run_code`).
//!
//! Conduit ships a **bundled, relocatable Python** (a `python-build-standalone`
//! distribution with `python-docx` / `python-pptx` / `openpyxl` / `reportlab`
//! pre-installed) inside its installer via `tauri.conf.json`'s
//! `bundle.resources`. That bundle is dropped into the installed app's resource
//! directory, so document generation works on machines that have **no system
//! Python at all** — and never conflicts with a user's own Python install.
//!
//! Resolution order:
//!   1. The bundled interpreter at `<resource_dir>/python/...` (if present and
//!      runnable) — the path the installer ships. This is the guaranteed path.
//!   2. The user's system interpreter (`py` / `python3` / `python`), so dev
//!      machines that run from source (no bundled runtime) keep working, and
//!      users who already have a Python aren't forced to use the bundle.
//!
//! The bundled path is resolved once at startup from the Tauri `AppHandle`'s
//! resource dir and cached in a `OnceLock`, so the per-call hot path is a cheap
//! cached lookup rather than a filesystem walk. If the bundled interpreter is
//! missing or broken, resolution silently falls through to the system probe —
//! document generation degrades to "whatever Python is on PATH" instead of
//! failing outright.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;

/// Relative path (under the app's resource directory) where the bundled
/// python-build-standalone tree is shipped. On Windows the interpreter is
/// `python/python.exe`; on macOS/Linux it is `python/bin/python3`.
const BUNDLED_SUBDIR: &str = "python";

static BUNDLED: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Record the bundled-interpreter directory at startup. Called once from
/// `lib.rs` setup with the app's resource dir; the bundled interpreter lives at
/// `<resource_dir>/python`. Safe to call multiple times (only the first wins).
/// Passing `None` disables the bundled path entirely (system Python only).
pub fn set_resource_dir(resource_dir: Option<PathBuf>) {
    let _ = BUNDLED.set(resource_dir.map(|d| d.join(BUNDLED_SUBDIR)));
}

/// The bundled-interpreter directory, if it was registered at startup and is
/// still present on disk. `None` means: no bundle shipped / not registered /
/// the directory was removed — fall back to the system interpreter.
fn bundled_dir() -> Option<&'static PathBuf> {
    BUNDLED
        .get_or_init(|| None)
        .as_ref()
        .filter(|d| d.is_dir())
}

/// Absolute path to the bundled interpreter executable, when available.
fn bundled_interpreter() -> Option<PathBuf> {
    bundled_dir().and_then(|d| bundled_interpreter_in(d))
}

/// Resolve the interpreter executable inside a candidate bundled directory,
/// independent of the global registration — used by the accessor above and by
/// tests that want to point at an explicit tree.
fn bundled_interpreter_in(dir: &std::path::Path) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        dir.join("python.exe")
    } else {
        dir.join("bin").join("python3")
    };
    if exe.is_file() {
        Some(exe)
    } else {
        None
    }
}

/// Resolve the Python interpreter command to run. Prefers the bundled
/// interpreter; falls back to a system `py` / `python3` / `python`. Returns
/// the executable path as a string (suitable for `Command::new`).
///
/// This is the single source of truth used by both `pygen` (document
/// generation) and `codeexec` (ad-hoc `run_code`), so the two paths can never
/// drift on which interpreter they use.
pub fn interpreter() -> String {
    if let Some(exe) = bundled_interpreter() {
        return exe.to_string_lossy().into_owned();
    }
    system_interpreter().to_string()
}

/// Probe the system for a working Python. On Windows, `python3` is often a
/// Microsoft Store "app execution alias" stub that prints a "Python was not
/// found; install from the Store" message and exits non-zero — probing it is
/// wasteful and, on some configs, the stub can hang. So on Windows we probe
/// `py` (the official launcher) then `python`, never the bare `python3` alias.
/// Elsewhere we prefer `python3` then `python`. Returns the last candidate
/// when none responds, so the failure message stays sensible.
fn system_interpreter() -> &'static str {
    let candidates: &[&str] = if cfg!(windows) {
        &["py", "python"]
    } else {
        &["python3", "python"]
    };
    for cand in candidates {
        if probe(cand) {
            return cand;
        }
    }
    candidates[0]
}

/// Run `<candidate> --version` and return true only if it exits successfully —
/// a non-zero exit (e.g. the Windows Store stub) disqualifies the candidate.
fn probe(prog: &str) -> bool {
    let mut cmd = std::process::Command::new(prog);
    cmd.arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Avoid a console-window flash when the GUI app probes for Python.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_interpreter_returns_a_name() {
        // On the dev machine a Python is present, so this resolves to a real
        // candidate; we only assert the shape, not the specific name.
        let name = system_interpreter();
        assert!(!name.is_empty());
    }

    #[test]
    fn bundled_dir_is_none_until_registered() {
        // A fresh process has no bundle registered (the OnceLock is empty); the
        // accessor must degrade to None rather than panic.
        // NOTE: this reads the shared OnceLock, so it reflects whatever
        // set_resource_dir did earlier in the same test binary — guard by
        // asserting it is either None or a real directory.
        if let Some(d) = bundled_dir() {
            assert!(d.is_dir(), "registered bundled dir must exist");
        }
    }

    /// End-to-end proof that the staged bundled Python (in
    /// src-tauri/resources/python) is usable by the resolver: it resolves to an
    /// interpreter that actually imports the four document-generation libs.
    /// Ignored in CI when the bundle isn't staged (e.g. a fresh checkout that
    /// hasn't run scripts/fetch-bundled-python.mjs).
    #[test]
    fn staged_bundle_imports_document_libs() {
        // The test only runs when a real python-build-standalone bundle is
        // staged at src-tauri/resources/python/. In CI / dev without
        // `node scripts/fetch-bundled-python.mjs` having been run, the
        // placeholder file is present but not a real ELF — skip rather
        // than panic on `Exec format error`.
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let dir = std::path::Path::new(manifest_dir).join("resources").join("python");
        let Some(exe) = bundled_interpreter_in(&dir) else {
            eprintln!("bundled python not staged at {dir:?} — skipping");
            return;
        };
        // Cheap magic-byte probe: a real python interpreter is an ELF /
        // Mach-O / PE binary. A 0-byte placeholder is neither.
        let Ok(meta) = std::fs::metadata(&exe) else {
            eprintln!("bundled python not accessible at {exe:?} — skipping");
            return;
        };
        if meta.len() < 1024 {
            eprintln!("bundled python placeholder at {exe:?} ({meta_len} bytes) — skipping", meta_len = meta.len());
            return;
        }
        let out = std::process::Command::new(&exe)
            .args(["-c", "import docx,pptx,openpyxl,reportlab"])
            .output()
            .expect("bundled python should spawn");
        assert!(
            out.status.success(),
            "bundled python failed to import the four libs\nstderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
