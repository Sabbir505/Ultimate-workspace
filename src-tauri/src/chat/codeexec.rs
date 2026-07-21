//! Sandboxed-ish local code execution for the chat `run_code` tool.
//!
//! Security posture (this is NOT a hard sandbox — see PR notes):
//!   * Opt-in only. The tool is registered / dispatched solely when the user
//!     has explicitly enabled code execution for the chat.
//!   * Each run executes in a fresh temporary working directory that is
//!     removed afterwards.
//!   * A hard wall-clock timeout kills runaway processes (`kill_on_drop`).
//!   * stdin is closed and output is capped so a program can't flood the UI.
//!
//! It does NOT provide OS-level isolation (namespaces / seccomp / containers);
//! executed code runs with the app's own privileges. Real isolation would need
//! a container or microVM and is tracked as future work.

use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::process::Command;
use tokio::time::timeout;

/// Wall-clock limit for a single execution.
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
/// Max bytes of combined stdout+stderr returned to the model.
const MAX_OUTPUT: usize = 12_000;

/// Languages the tool understands. Returns the interpreter program and the
/// temp source-file extension.
fn interpreter(language: &str) -> Option<(&'static str, &'static str)> {
    match language.to_lowercase().as_str() {
        "python" | "py" | "python3" => Some(("python3", "py")),
        "javascript" | "js" | "node" => Some(("node", "js")),
        "bash" | "sh" | "shell" => Some(("bash", "sh")),
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

    let mut cmd = Command::new(program);
    cmd.arg(&src)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

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

    match result {
        Err(msg) => msg,
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
