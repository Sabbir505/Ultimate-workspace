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
/// D5: drain-buffer ceiling per pipe. The final text is capped to
/// [`MAX_OUTPUT`] anyway; this bounds what we hold in RAM WHILE draining, so
/// a `print`-looping snippet can't buffer GBs inside the 20s window (the old
/// `wait_with_output` accumulated the entire stream unbounded).
const EXEC_DRAIN_CAP: usize = 512 * 1024;

/// D5: bounded replacement for `Child::wait_with_output`. Waits for `child`
/// while draining stdout/stderr into [`crate::util::BoundedTail`]s (the LAST
/// `cap` bytes of each pipe), returning (status, stdout tail, stderr tail).
/// `kill_on_drop` still applies on timeout — dropping this future drops the
/// child, which kills it.
pub(crate) async fn wait_with_bounded_output(
    mut child: tokio::process::Child,
    cap: usize,
) -> std::io::Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>)> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (out_tail, err_tail, status) = tokio::join!(
        async {
            match stdout {
                Some(p) => drain_pipe_bounded(p, cap).await,
                None => Vec::new(),
            }
        },
        async {
            match stderr {
                Some(p) => drain_pipe_bounded(p, cap).await,
                None => Vec::new(),
            }
        },
        child.wait(),
    );
    status.map(|s| (s, out_tail, err_tail))
}

/// Drain one child pipe into a bounded tail, chunk by chunk.
async fn drain_pipe_bounded<R: tokio::io::AsyncRead + Unpin>(
    mut pipe: R,
    cap: usize,
) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut tail = crate::util::BoundedTail::new(cap);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => tail.push(&chunk[..n]),
        }
    }
    tail.into_bytes()
}

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
        Ok(child) => {
            match timeout(
                EXEC_TIMEOUT,
                wait_with_bounded_output(child, EXEC_DRAIN_CAP),
            )
            .await
            {
                Ok(Ok((status, stdout, stderr))) => Ok((status, stdout, stderr)),
                Ok(Err(e)) => Err(format!("Error: execution failed: {e}")),
                Err(_) => Err(format!(
                    "Error: execution timed out after {}s (process killed).",
                    EXEC_TIMEOUT.as_secs()
                )),
            }
        }
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
        Ok((status, stdout_bytes, stderr_bytes)) => {
            let stdout = String::from_utf8_lossy(&stdout_bytes);
            let stderr = String::from_utf8_lossy(&stderr_bytes);
            let code = status.code();
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

    #[test]
    fn print_loop_output_is_capped() {
        // D5: a print-looping snippet must come back as the small capped
        // result (Exit code + ≤ MAX_OUTPUT tail), whatever the interpreter
        // streams at us. Soft-skips when no Python is installed (the bounded
        // drain itself is pinned by wait_with_bounded_output_tails_both_pipes
        // and the util::BoundedTail unit tests).
        if which_python_missing() {
            eprintln!("skipping: no Python interpreter on this machine");
            return;
        }
        // ~4MB of stdout — far past both the drain cap and MAX_OUTPUT.
        let code = "for i in range(50000):\n    print('x' * 80)\n";
        let out = tauri::async_runtime::block_on(run_code("python", code));
        assert!(out.contains("Exit code: 0"), "got: {out}");
        assert!(
            out.len() < MAX_OUTPUT + 2_000,
            "output must be capped, got {} bytes",
            out.len()
        );
        assert!(
            out.contains("output truncated"),
            "overflowing output must say so: {}",
            &out[..out.len().min(200)]
        );
    }

    /// True when no Python answers (mirrors python_runtime's probe order).
    fn which_python_missing() -> bool {
        let candidates: &[&str] = if cfg!(windows) {
            &["py", "python"]
        } else {
            &["python3", "python"]
        };
        !candidates.iter().any(|c| {
            std::process::Command::new(c)
                .arg("-c")
                .arg("print(1)")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
    }

    #[test]
    fn wait_with_bounded_output_tails_both_pipes() {
        // Direct check of the bounded wait on a script that shouts on BOTH
        // pipes (uses the shell so no Python dependency).
        let mut cmd = Command::new(if cfg!(windows) { "cmd.exe" } else { "sh" });
        cmd.arg(if cfg!(windows) { "/C" } else { "-c" });
        let script: &str = if cfg!(windows) {
            "for /l %i in (1,1,1000) do @(echo out-stream-line & echo err-stream-line 1>&2)"
        } else {
            "i=0; while [ $i -lt 1000 ]; do echo out-stream-line; echo err-stream-line 1>&2; i=$((i+1)); done"
        };
        cmd.arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = cmd.spawn().expect("spawn shell");
        let (status, out, err) = tauri::async_runtime::block_on(
            wait_with_bounded_output(child, 4096),
        )
        .expect("wait succeeds");
        assert!(status.success());
        let out = String::from_utf8_lossy(&out);
        let err = String::from_utf8_lossy(&err);
        assert!(out.len() <= 4096, "stdout tail bounded, got {}", out.len());
        assert!(err.len() <= 4096, "stderr tail bounded, got {}", err.len());
        // The TAIL is what's kept: the LAST lines must be present.
        assert!(out.contains("out-stream-line"), "stdout tail: {out}");
        assert!(err.contains("err-stream-line"), "stderr tail: {err}");
    }
}
