//! JavaScript document generation bridge for the chat `generate_document`
//! tool (`language: "javascript"`).
//!
//! The model authors a short JS program against `docx` (npm) or `PptxGenJS`,
//! exactly the engines Anthropic's public document skills use. The program is
//! executed by the **frontend** (`DocCodeRunner` component) inside a sandboxed
//! iframe with the library bundles preloaded, because the libraries are
//! browser-side and the app ships no Node runtime. This module is the Rust
//! half of that round-trip: emit a `docgen://run` event to the main window,
//! park an async waiter, and let the `docgen_complete` IPC command resolve it
//! with the produced file bytes (base64) or an error.
//!
//! Security posture: identical to `pygen` — the code is model-authored and
//! runs with the app's privileges; the iframe isolates the DOM but is not an
//! OS sandbox. When no main window exists (headless automation runs), the
//! bridge times out fast and the tool guides the model to the Python engine.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use once_cell::sync::Lazy;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use super::artifacts;

/// Wall-clock limit for the frontend run (the runner also enforces its own,
/// shorter watchdog and reports back first).
const GEN_TIMEOUT: Duration = Duration::from_secs(120);

/// Event the frontend runner listens for.
const RUN_EVENT: &str = "docgen://run";

struct PendingRun {
    tx: oneshot::Sender<Result<Vec<u8>, String>>,
}

static PENDING: Lazy<parking_lot::Mutex<HashMap<String, PendingRun>>> =
    Lazy::new(|| parking_lot::Mutex::new(HashMap::new()));

/// Formats the JS engines cover: documents and decks. xlsx stays Python
/// (openpyxl), pdf stays HTML/ReportLab.
pub fn is_supported(format: &str) -> bool {
    matches!(format, "docx" | "pptx")
}

/// Run model-authored JS in the frontend runner and save the produced file
/// into `dir` as `filename` (a `format` document). Returns the written file.
pub async fn generate(
    app: &AppHandle,
    dir: &Path,
    format: &str,
    filename: &str,
    code: &str,
) -> Result<super::pygen::Generated, String> {
    if code.trim().is_empty() {
        return Err("generate_document requires non-empty \"code\".".to_string());
    }
    if !is_supported(format) {
        return Err(format!("the JavaScript engine supports docx and pptx (got \"{format}\")"));
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

    let Some(window) = app.get_webview_window("main") else {
        return Err(
            "the JavaScript document engine needs the app window (not available in this \
             headless run). Re-run with language=\"python\" to use the bundled Python \
             engine instead."
                .to_string(),
        );
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
    PENDING.lock().insert(request_id.clone(), PendingRun { tx });

    // Emit to the runner; if the listener is missing (old frontend build,
    // headless mode) the waiter below times out and we clean up.
    let emit_result = window.emit(
        RUN_EVENT,
        json!({
            "requestId": request_id,
            "format": format,
            "filename": name,
            "code": code,
        }),
    );
    if let Err(e) = emit_result {
        PENDING.lock().remove(&request_id);
        return Err(format!("could not reach the document runner: {e}"));
    }

    let bytes = match tokio::time::timeout(GEN_TIMEOUT, rx).await {
        Ok(Ok(Ok(bytes))) if !bytes.is_empty() => bytes,
        Ok(Ok(Ok(_))) => {
            PENDING.lock().remove(&request_id);
            return Err("the document runner produced an empty file. Check the code calls \
                        `await relay.save(...)` exactly once with the finished document."
                .to_string());
        }
        Ok(Ok(Err(e))) => {
            PENDING.lock().remove(&request_id);
            return Err(format!("the document runner reported an error: {e}"));
        }
        Ok(Err(_)) | Err(_) => {
            PENDING.lock().remove(&request_id);
            return Err(format!(
                "the document runner did not answer within {}s (it may not be loaded in \
                 this window). Re-run with language=\"python\" to use the bundled Python \
                 engine instead.",
                GEN_TIMEOUT.as_secs()
            ));
        }
    };

    std::fs::write(&out_path, &bytes).map_err(|e| format!("could not write the document: {e}"))?;
    Ok(super::pygen::Generated {
        path: out_path,
        filename: name,
        log: "generated with the in-app JavaScript engine (docx / PptxGenJS)".to_string(),
    })
}

/// Resolve a pending run — called by the `docgen_complete` IPC command with
/// whatever the frontend runner produced. Unknown request ids are ignored
/// (late double-completions, stale frames).
pub fn complete(request_id: &str, result: Result<Vec<u8>, String>) {
    if let Some(run) = PENDING.lock().remove(request_id) {
        let _ = run.tx.send(result);
    }
}

/// Base64-decode helper shared with the IPC command (the wire carries base64
/// to keep the JSON payload text-safe).
pub(crate) fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("invalid base64 payload from the document runner: {e}"))
}

/// Output path helper reused by tests.
pub(crate) fn planned_path(dir: &Path, format: &str, filename: &str) -> PathBuf {
    let ext = artifacts::canonical_ext(format);
    let base = artifacts::sanitize_filename(filename);
    let name = if base.to_lowercase().ends_with(&format!(".{ext}")) {
        base
    } else {
        format!("{base}.{ext}")
    };
    dir.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_formats() {
        assert!(is_supported("docx"));
        assert!(is_supported("pptx"));
        assert!(!is_supported("xlsx"));
        assert!(!is_supported("pdf"));
    }

    #[test]
    fn planned_paths_add_extension() {
        let dir = Path::new("C:\\artifacts");
        assert_eq!(
            planned_path(dir, "docx", "Report"),
            dir.join("Report.docx")
        );
        assert_eq!(
            planned_path(dir, "pptx", "deck.pptx"),
            dir.join("deck.pptx")
        );
    }

    #[test]
    fn decode_rejects_garbage() {
        assert!(decode_base64("!!!not-base64!!!").is_err());
        assert_eq!(decode_base64("aGk=").unwrap(), b"hi");
    }
}
