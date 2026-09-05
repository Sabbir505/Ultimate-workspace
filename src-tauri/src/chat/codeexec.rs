//! Local code execution for the chat `run_code` tool.
//!
//! Security posture:
//!   * Opt-in only. The tool is registered / dispatched solely when the user
//!     has explicitly enabled code execution for the chat.
//!   * Each run executes in a fresh temporary working directory that is
//!     removed afterwards.
//!   * A hard wall-clock timeout kills runaway processes (`kill_on_drop`).
//!   * stdin is closed and output is capped so a program can't flood the UI.
//!
//! NOTE: no OS-level sandbox is currently enforced. The `apply_sandbox` hook
//! reserves the integration point for Landlock (Linux), Job Objects + restricted
//! token (Windows) and `sandbox-exec` (macOS), but none is wired up yet — see
//! the comment there. `sandbox_available()` therefore returns `false` so the
//! result text honestly warns the user that the snippet ran with full user
//! privileges (including network) rather than silently claiming confinement.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::process::Command;
use tokio::time::timeout;

/// Wall-clock limit for a single execution.
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
/// Max bytes of combined stdout+stderr returned to the model.
const MAX_OUTPUT: usize = 12_000;

/// True if the host currently enforces a real sandbox around `run_code`.
/// Logged once per process so the user (and our own audits) can see when we
/// degraded to "no sandbox".
///
/// Currently always `false`: `apply_sandbox` only reserves the integration
/// point for Landlock / Job Objects / `sandbox-exec` — none is wired up yet.
/// Returning `false` here keeps the "no OS-level sandbox" warning honest
/// instead of advertising confinement that isn't actually enforced.
fn sandbox_available() -> bool {
    false
}

/// Reserve the integration point for an OS-level sandbox around `run_code`.
///
/// Currently a NO-OP on every platform: this only marks where a future Landlock
/// (Linux), Job-Object + restricted-token (Windows) or `sandbox-exec` (macOS)
/// integration would wrap `cmd`. Because nothing is enforced yet,
/// `sandbox_available()` returns `false` and the result text warns the user
/// that the snippet ran with full user privileges (including network).
fn apply_sandbox(cmd: &mut Command, work_dir: &Path) {
    #[cfg(target_os = "linux")]
    {
        // TODO(landlock): allocate a `landlock_ruleset_attr`, re-allow
        // `work_dir` (writable) and `/usr`, `/lib`, `/etc` (read-only) so the
        // interpreter can boot, then restrict the child to that ruleset. Needs
        // either the `landlock` crate or a `seccompiler` filter — neither is a
        // dependency yet, so we deliberately do nothing here rather than ship a
        // half-applied policy that looks enforced but isn't.
        let _ = (cmd, work_dir);
    }
    #[cfg(target_os = "macos")]
    {
        // TODO(sandbox-exec): wrap the interpreter in
        // `sandbox-exec -p '<profile>'` with a profile that denies network and
        // limits writes to `work_dir` (see the draft below). `Command` can't
        // redirect an already-built program, so this needs a pre-exec shim or
        // a rebuilt argv — left unimplemented for now. The profile is sketched
        // here only as a reference; it is NOT applied.
        let _profile = format!(
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
        let _ = (cmd, work_dir);
    }
    #[cfg(target_os = "windows")]
    {
        // TODO(job+token): assign the child to a Job Object with network/UI
        // restrictions and launch it on a restricted token. Needs Windows-only
        // deps (`windows-sys` Job Objects / Threading / Security features),
        // which are not currently enabled in Cargo.toml — so nothing is done.
        let _ = (cmd, work_dir);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (cmd, work_dir);
    }
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
        // node and bash — plain system interpreters. `apply_sandbox` above is
        // a NO-OP on every platform today, so these run with FULL user
        // privileges (including network); `run_code` appends the honest
        // "no OS-level sandbox" warning to the result for that reason.
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
    let dir = std::env::temp_dir().join(format!("relay_exec_{nanos}"));
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
        "\n⚠ No OS-level sandbox is enforced — code ran with full user privileges (including network). Enable code execution only for trusted prompts."
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
