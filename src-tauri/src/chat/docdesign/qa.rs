//! docdesign QA — the L4 render-probe round trip and the `chat:doc-qa`
//! report.
//!
//! After a plan-compiled document is written, the host asks the frontend to
//! probe the RENDERED artifact: the office file is converted to PDF through
//! the cached LibreOffice bridge and inspected with pdf.js (text outside the
//! page box, blank pages, page count). This module parks the waiter for that
//! round trip (mirroring [`super::plan`]) and assembles the QA report that
//! reaches the UI as a `chat:doc-qa` event and the model as tool text.
//!
//! Probe failures degrade gracefully: a skipped probe is a warning in the
//! report, never a failed generation — the document is already saved.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

/// Event the frontend listens for to run render probes.
pub const QA_EVENT: &str = "docdesign://qa";
/// Event carrying the assembled QA report to the UI (keyed by artifact path).
pub const DOC_QA_EVENT: &str = "chat:doc-qa";

const QA_TIMEOUT: Duration = Duration::from_secs(90);

struct PendingProbe {
    tx: oneshot::Sender<ProbeOutcome>,
}

/// What the frontend measured on the rendered document.
#[derive(Default)]
pub struct ProbeOutcome {
    pub issues: Vec<String>,
    pub page_count: u32,
    pub skipped: bool,
}

static PENDING: Lazy<parking_lot::Mutex<HashMap<String, PendingProbe>>> =
    Lazy::new(|| parking_lot::Mutex::new(HashMap::new()));

/// The full design-QA verdict for one generated document.
#[derive(Default)]
pub struct QaReport {
    pub passed: Vec<String>,
    pub warnings: Vec<String>,
    pub probes: Vec<String>,
    pub page_count: u32,
    /// Status of the (optional) visual critique layer.
    pub critic: String,
}

impl QaReport {
    pub fn is_clean(&self) -> bool {
        self.warnings.is_empty() && self.probes.is_empty()
    }

    /// One-line summary for the tool-result text.
    pub fn summary_line(&self) -> String {
        if self.is_clean() {
            format!(
                "Design QA: clean — {} check(s) passed, {} page(s) probed.",
                self.passed.len(),
                self.page_count
            )
        } else {
            format!(
                "Design QA: {} warning(s) — {} check(s) passed, {} page(s) probed.",
                self.warnings.len() + self.probes.len(),
                self.passed.len(),
                self.page_count
            )
        }
    }

    /// JSON payload for the `chat:doc-qa` event (camelCase for the frontend).
    pub fn event_payload(&self, path: &Path, filename: &str) -> Value {
        json!({
            "path": path.display().to_string(),
            "filename": filename,
            "passed": self.passed,
            "warnings": self.warnings,
            "probes": self.probes,
            "pageCount": self.page_count,
            "critic": self.critic,
            "clean": self.is_clean(),
        })
    }
}

/// Parse the frontend probe response (JSON issue array + page count).
pub(crate) fn parse_probe_payload(issues_json: Option<String>, page_count: u32) -> ProbeOutcome {
    let mut out = ProbeOutcome {
        page_count,
        ..Default::default()
    };
    let Some(raw) = issues_json else {
        return out;
    };
    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw.trim()) {
        for item in items {
            if let Some(message) = item.get("message").and_then(|v| v.as_str()) {
                let rule = item.get("rule").and_then(|v| v.as_str()).unwrap_or("probe");
                if message.is_empty() {
                    continue;
                }
                if rule == "probe/skipped" {
                    out.skipped = true;
                }
                out.issues.push(format!("{rule}: {message}"));
            }
        }
    }
    out
}

/// Ask the frontend to probe the rendered artifact. Returns `None` when no
/// window is available (headless) or the round trip times out — the caller
/// proceeds either way.
pub async fn run_render_probes(
    app: &AppHandle,
    path: &Path,
    format: &str,
) -> Option<ProbeOutcome> {
    let Some(window) = app.get_webview_window("main") else {
        return None;
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<ProbeOutcome>();
    PENDING.lock().insert(request_id.clone(), PendingProbe { tx });

    let emit = window.emit(
        QA_EVENT,
        json!({
            "requestId": request_id,
            "path": path.display().to_string(),
            "format": format,
        }),
    );
    if let Err(e) = emit {
        PENDING.lock().remove(&request_id);
        eprintln!("docdesign qa: could not reach the frontend: {e}");
        return None;
    }

    match tokio::time::timeout(QA_TIMEOUT, rx).await {
        Ok(Ok(outcome)) => Some(outcome),
        _ => {
            PENDING.lock().remove(&request_id);
            None
        }
    }
}

/// Resolve a pending probe — called by the `docdesign_qa_complete` IPC
/// command. Unknown request ids are ignored (late/double completions).
pub fn complete(request_id: &str, issues_json: Option<String>, page_count: u32) {
    if let Some(probe) = PENDING.lock().remove(request_id) {
        let _ = probe.tx.send(parse_probe_payload(issues_json, page_count));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_payload_parses_issues_and_count() {
        let out = parse_probe_payload(
            Some(
                r#"[{"severity":"warning","rule":"probe/overflow","message":"page 2: text renders outside the page box","pointer":"page:2"},
                    {"severity":"warning","rule":"probe/blank-page","message":"1 blank page"}]"#
                    .to_string(),
            ),
            7,
        );
        assert_eq!(out.page_count, 7);
        assert_eq!(out.issues.len(), 2);
        assert!(out.issues[0].starts_with("probe/overflow:"));
        assert!(!out.skipped);
    }

    #[test]
    fn probe_skip_is_flagged() {
        let out = parse_probe_payload(
            Some(r#"[{"rule":"probe/skipped","message":"render probes could not run (no pdf)"}]"#.to_string()),
            0,
        );
        assert!(out.skipped);
        assert_eq!(out.issues.len(), 1);
    }

    #[test]
    fn probe_payload_tolerates_garbage() {
        let out = parse_probe_payload(Some("not json".to_string()), 3);
        assert_eq!(out.page_count, 3);
        assert!(out.issues.is_empty());
        let out = parse_probe_payload(None, 0);
        assert!(out.issues.is_empty() && out.page_count == 0);
    }

    #[test]
    fn report_summaries_and_payload() {
        let mut r = QaReport {
            passed: vec!["a", "b", "c"].into_iter().map(String::from).collect(),
            ..Default::default()
        };
        r.critic = "not-run".into();
        assert!(r.is_clean());
        assert!(r.summary_line().contains("clean"));
        assert!(r.summary_line().contains("3 check(s)"));

        r.warnings.push(String::from("coherence: no cover"));
        r.probes.push(String::from("probe/overflow: page 2"));
        assert!(!r.is_clean());
        assert!(r.summary_line().contains("2 warning(s)"));

        let payload = r.event_payload(Path::new("C:\\a\\deck.pptx"), "deck.pptx");
        assert_eq!(payload["filename"], "deck.pptx");
        assert_eq!(payload["pageCount"], 0);
        assert_eq!(payload["warnings"].as_array().unwrap().len(), 1);
        assert_eq!(payload["probes"].as_array().unwrap().len(), 1);
        assert_eq!(payload["clean"], json!(false));
    }

    #[test]
    fn complete_without_waiter_is_ignored() {
        complete("no-such-qa", None, 0);
    }
}
