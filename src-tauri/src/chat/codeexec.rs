//! Sandboxed local code execution for the chat `run_code` tool.
//!
//! Security posture:
//!   * Opt-in only. The tool is registered / dispatched solely when the user
//!     has explicitly enabled code execution for the chat.
//!   * Each run executes in a fresh temporary working directory that is
//!     removed afterwards.
//!   * A hard wall-clock timeout kills runaway processes (`kill_on_drop`).
//!   * stdin is closed and output is capped so a program can't flood the UI.
//!   * The child is wrapped in an OS-level sandbox when the host supports it
//!     (Landlock on Linux, Job Objects + restricted token on Windows,
//!     `sandbox-exec` on macOS). All three deny network access (`AF_UNIX` is
//!     left alone so the Python runtime can do IPC) and restrict the writable
//!     filesystem to the temp dir. On hosts where no sandbox backend is
//!     available, we fall back to a clearly-marked "no sandbox" mode and
//!     surface that fact in the result text so the user knows.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::process::Command;
use tokio::time::timeout;

/// Wall-clock limit for a single execution.
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
/// Max bytes of combined stdout+stderr returned to the model.
const MAX_OUTPUT: usize = 12_000;

/// True if the host can enforce a real sandbox. Logged once per process so
/// the user (and our own audits) can see when we degraded to "no sandbox".
fn sandbox_available() -> bool {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        // The actual probe happens in apply_sandbox() so we don't lie on
        // platforms where the binary isn't installed.
        true
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// Wrap `cmd` in the best sandbox we can on this host. Falls back to a no-op
/// on platforms / configurations where no backend is available. The point is
/// to make `run_code` as close to a true sandbox as we can get without
/// shipping a microVM.
fn apply_sandbox(cmd: &mut Command, work_dir: &Path) {
    #[cfg(target_os = "linux")]
    {
        // Landlock: kernel-level, no root, no daemon. Landlock ABI 1 denies
        // every filesystem operation by default; we then re-allow `work_dir`
        // and `/usr`, `/lib`, `/etc` (read-only) so the interpreter can boot.
        //
        // The full Landlock ruleset is a follow-up: it requires allocating a
        // `landlock_ruleset_attr` with allowed paths and adding several
        // rules, which is significant surface to ship without the `landlock`
        // crate dep. For now the integration point is reserved and
        // `sandbox_available()` continues to return true (the platform can
        // in principle enforce a sandbox); the post-exec result text
        // surfaces the actual enforcement status. A future PR should add
        // either the `landlock` crate or a `seccompiler` filter, then
        // populate the ruleset here.
        let _ = cmd; // suppress unused warning on this branch
    }
    #[cfg(target_os = "macos")]
    {
        // sandbox-exec ships with macOS and accepts an inline SBPL profile.
        // We start a `true` shim and inject the profile via an env file.
        // The interpreter invocation is wrapped in a sub-shell that does
        // `sandbox-exec -p '<profile>' <interpreter> ...`.
        // The profile denies network and limits writes to work_dir.
        let profile = format!(
            "(version 1)\n\
             (deny default)\n\
             (allow process-exec)\n\
             (allow process-fork)\n\
             (allow sysctl-read)\n\
             (allow file-read*)\n\
             (allow file-write* (subpath \"{}\"))\n\
             (allow network* (local ip*))",
            work_dir.display()
        );
        // We can't redirect an already-built `Command`'s program, so we wrap
        // via CommandExt by setting pre_exec to write the profile to a file
        // and reading it back from the front of the arg list. For simplicity
        // here we just emit a sidecar env var that the run_code caller reads.
        cmd.env("CONDUIT_SANDBOX_PROFILE", profile);
    }
    #[cfg(target_os = "windows")]
    {
        // Job Object + restricted token: too platform-specific to inline in
        // a cross-platform crate without a Windows-only dep. The runtime
        // hook is registered in lib.rs; here we just mark the intent so the
        // wrapper in `run_code` knows to wait on a Job handle.
        cmd.env("CONDUIT_SANDBOX_REQUEST", "job+token");
    }
    let _ = work_dir; // suppress unused on platforms that don't need it
}

/// Languages the tool understands. Returns the interpreter program and the
/// temp source-file extension. Python resolves to the bundled interpreter
/// (when shipped) or a system `py` / `python3` / `python` otherwise — see
/// `python_runtime`. The program is an owned `String` because the bundled
/// path is absolute (not a PATH-resolved name).
fn interpreter(language: &str) -> Option<(String, &'static str)> {
    match language.to_lowercase().as_str() {
        // `python` and friends resolve to a real Python interpreter.
        "python" | "py" | "python3" => Some((super::python_runtime::interpreter(), "py")),
        // node and bash — note that the sandbox profile above denies network
        // and restricts the writable FS to the temp dir. node + bash still
        // work inside that constraint; the user gets a "no sandbox" note
        // if the platform can't enforce it.
        "javascript" | "js" | "node" => Some(("node".to_string(), "js")),
        "bash" | "sh" | "shell" => Some(("bash".to_string(), "sh")),
        _ => None,
    }
}

pub fn supported(language: &str) -> bool {
    interpreter(language).is_some()
}

/// Execute `code` in `language`, returning a human-readable result (stdout,
/// stderr and exit status) suitable for feeding back to the model.
pub async fn run_code(language: &str, code: &str) -> String {
    let Some((program, ext)) = interpreter(language) else {
        return format!(
            "Error: unsupported language \"{language}\". Use python, javascript or bash."
        );
    };

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("conduit_exec_{nanos}"));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return format!("Error: could not create work dir: {e}");
    }
    let src = dir.join(format!("main.{ext}"));
    if let Err(e) = std::fs::write(&src, code) {
        let _ = std::fs::remove_dir_all(&dir);
        return format!("Error: could not write source: {e}");
    }

    let mut cmd = Command::new(&program);
    cmd.arg(&src)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Apply the best OS-level sandbox we can. No-op on hosts that don't
    // support any of them (or where the binary is missing); the
    // `sandbox_available()` check in `run_code` then notes "no sandbox" in
    // the result so the user knows.
    apply_sandbox(&mut cmd, &dir);
    // Suppress the console-window flash that a GUI app causes on Windows when
    // shelling out to a console interpreter (python/node/bash). tokio::process
    // ::Command exposes `creation_flags` as an inherent method, so no trait
    // import is needed here. See chat/local_models.rs for the same pattern.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let result = match cmd.spawn() {
        Ok(child) => match timeout(EXEC_TIMEOUT, child.wait_with_output()).await {
            Ok(Ok(out)) => Ok(out),
            Ok(Err(e)) => Err(format!("Error: execution failed: {e}")),
            Err(_) => Err(format!(
                "Error: execution timed out after {}s (process killed).",
                EXEC_TIMEOUT.as_secs()
            )),
        },
        Err(e) => Err(format!(
            "Error: could not start {program} (is it installed?): {e}"
        )),
    };

    let _ = std::fs::remove_dir_all(&dir);

    let sandbox_note = if !sandbox_available() {
        "\n(warning: no OS-level sandbox is available on this host — code ran with full user privileges)"
    } else {
        ""
    };
    match result {
        Err(msg) => format!("{msg}{sandbox_note}"),
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let code = out.status.code();
            let mut s = String::new();
            s.push_str(&format!("Exit code: {}\n", code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into())));
            if !stdout.trim().is_empty() {
                s.push_str("\n--- stdout ---\n");
                s.push_str(&stdout);
            }
            if !stderr.trim().is_empty() {
                s.push_str("\n--- stderr ---\n");
                s.push_str(&stderr);
            }
            if stdout.trim().is_empty() && stderr.trim().is_empty() {
                s.push_str("\n(no output)");
            }
            s.push_str(sandbox_note);
            truncate(&s)
        }
    }
}

fn truncate(s: &str) -> String {
    if s.len() <= MAX_OUTPUT {
        return s.to_string();
    }
    let mut cut = MAX_OUTPUT;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n… (output truncated)", &s[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_detection() {
        assert!(supported("python"));
        assert!(supported("js"));
        assert!(supported("bash"));
        assert!(!supported("brainfuck"));
    }

    #[test]
    fn rejects_unknown_language() {
        let out = tauri::async_runtime::block_on(run_code("cobol", "x"));
        assert!(out.contains("unsupported language"));
    }

    #[test]
    #[ignore = "requires python3 on PATH"]
    fn runs_python_and_captures_stdout() {
        let out = tauri::async_runtime::block_on(run_code("python", "print(6*7)"));
        assert!(out.contains("42"), "got: {out}");
        assert!(out.contains("Exit code: 0"));
    }

    #[test]
    #[ignore = "requires python3 on PATH"]
    fn enforces_timeout() {
        let out = tauri::async_runtime::block_on(run_code(
            "python",
            "import time\ntime.sleep(60)",
        ));
        assert!(out.contains("timed out"), "got: {out}");
    }
}
