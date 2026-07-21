//! Python-backed rich document generation for the chat `generate_document`
//! tool.
//!
//! Unlike [`super::artifacts`] (which writes files directly and never executes
//! model input), this module runs a short model-authored Python program to
//! build a professionally formatted `docx` / `pptx` / `xlsx` / `pdf` using the
//! `python-docx`, `python-pptx`, `openpyxl` and `reportlab` libraries. This is
//! how genuinely styled documents (title pages, typography, tables, coloured
//! layouts, real slide decks) are produced — the model knows those libraries
//! well and emits the layout code.
//!
//! Security posture (identical to `codeexec`): this executes model-written
//! Python with the app's own privileges. It is NOT an OS-level sandbox. The
//! program runs with its working directory set to the artifacts directory so
//! its output lands there, under a wall-clock timeout, with stdin closed and
//! output capped.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use super::artifacts;

/// Wall-clock limit for a single document-generation run. Larger than plain
/// code execution because building a rich deck/report can be slower.
const GEN_TIMEOUT: Duration = Duration::from_secs(90);
/// Max bytes of the program's own stdout/stderr fed back to the model.
const MAX_OUTPUT: usize = 8_000;

/// A document produced on disk by the Python program.
pub struct Generated {
    pub path: PathBuf,
    pub filename: String,
    /// Program output (stdout/stderr), for narrating success back to the model.
    pub log: String,
}

/// Formats that are worth generating with Python (rich layout libraries).
pub fn is_supported(format: &str) -> bool {
    matches!(format, "docx" | "pptx" | "xlsx" | "pdf")
}

/// Run `code` (Python) to produce `filename` (a `format` document) inside
/// `dir`. The program's working directory is `dir`, and the intended absolute
/// output path is exposed as the `CONDUIT_OUTPUT` environment variable.
pub async fn generate(
    dir: &Path,
    format: &str,
    filename: &str,
    code: &str,
) -> Result<Generated, String> {
    if code.trim().is_empty() {
        return Err("generate_document requires non-empty \"code\".".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create artifacts dir: {e}"))?;

    let ext = artifacts::canonical_ext(format);
    let base = artifacts::sanitize_filename(filename);
    let name = if base.to_lowercase().ends_with(&format!(".{ext}")) {
        base
    } else {
        format!("{base}.{ext}")
    };
    let out_path = dir.join(&name);

    // Files already present, so we can detect what the program creates even if
    // it saves under a slightly different name than requested.
    let before = list_dir(dir);

    // Write the program to a private temp file (kept out of the artifacts dir
    // so it is never surfaced as an artifact) and run it with cwd = artifacts
    // dir so a relative `filename` resolves there.
    let tmp = std::env::temp_dir().join(format!("conduit_pygen_{}", unique_suffix()));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("could not create work dir: {e}"))?;
    let script = tmp.join("gen.py");
    if let Err(e) = std::fs::write(&script, code) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("could not write generator script: {e}"));
    }

    let mut cmd = Command::new("python3");
    cmd.arg(&script)
        .current_dir(dir)
        .env("CONDUIT_OUTPUT", &out_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let run = match cmd.spawn() {
        Ok(child) => match timeout(GEN_TIMEOUT, child.wait_with_output()).await {
            Ok(Ok(out)) => Ok(out),
            Ok(Err(e)) => Err(format!("generation failed: {e}")),
            Err(_) => Err(format!(
                "generation timed out after {}s (process killed).",
                GEN_TIMEOUT.as_secs()
            )),
        },
        Err(e) => Err(format!(
            "could not start python3 (is Python installed?): {e}"
        )),
    };

    let _ = std::fs::remove_dir_all(&tmp);

    let out = run?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let log = truncate(&format!("{stdout}{stderr}"));

    // Prefer the exact requested path; otherwise fall back to the newest file
    // the program created with the right extension.
    let produced = if out_path.exists() {
        Some((out_path.clone(), name.clone()))
    } else {
        newest_new_file(dir, &before, ext)
    };

    match produced {
        Some((path, filename)) => Ok(Generated { path, filename, log }),
        None => {
            let hint = if !out.status.success() {
                format!("The program exited with an error:\n{log}")
            } else {
                format!(
                    "The program ran but did not create the expected file. \
                     Save the document to the path in the CONDUIT_OUTPUT env var \
                     (or to \"{name}\" in the current directory).\nProgram output:\n{log}"
                )
            };
            Err(hint)
        }
    }
}

fn list_dir(dir: &Path) -> HashSet<PathBuf> {
    let mut set = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            set.insert(e.path());
        }
    }
    set
}

/// The newest file in `dir` that is not in `before` and ends with `.ext`.
fn newest_new_file(
    dir: &Path,
    before: &HashSet<PathBuf>,
    ext: &str,
) -> Option<(PathBuf, String)> {
    let want = format!(".{}", ext.to_lowercase());
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if before.contains(&p) {
            continue;
        }
        if !p
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase().ends_with(&want))
            .unwrap_or(false)
        {
            continue;
        }
        let mtime = e.metadata().and_then(|m| m.modified()).ok()?;
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, p));
        }
    }
    best.map(|(_, p)| {
        let filename = p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        (p, filename)
    })
}

fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn truncate(s: &str) -> String {
    let s = s.trim();
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
    fn supported_formats() {
        assert!(is_supported("docx"));
        assert!(is_supported("pptx"));
        assert!(is_supported("pdf"));
        assert!(!is_supported("txt"));
        assert!(!is_supported("md"));
    }

    #[test]
    fn rejects_empty_code() {
        let dir = tempfile::tempdir().unwrap();
        let out = tauri::async_runtime::block_on(generate(dir.path(), "docx", "x", "  "));
        assert!(out.is_err());
    }

    #[test]
    #[ignore = "requires python3 + python-docx"]
    fn generates_docx_via_python() {
        let dir = tempfile::tempdir().unwrap();
        let code = r#"
from docx import Document
import os
d = Document()
d.add_heading("Hello", 0)
d.add_paragraph("Body text.")
d.save(os.environ["CONDUIT_OUTPUT"])
"#;
        let g = tauri::async_runtime::block_on(generate(dir.path(), "docx", "report", code))
            .expect("generation");
        assert!(g.path.exists());
        assert!(g.filename.ends_with(".docx"));
    }
}
