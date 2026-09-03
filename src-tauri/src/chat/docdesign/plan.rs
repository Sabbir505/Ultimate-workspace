//! `plan_document` — the plan-first, design-system-compiled document path.
//!
//! The model authors a structured plan (deck IR), NOT engine code. This module
//! light-validates the plan, emits a `docdesign://compile` event to the main
//! window, and parks a oneshot waiter (mirroring [`super::jsdocgen`]). The
//! frontend `DocDesignRunner` runs QA layer L1 (plan/catalog validation),
//! deterministically compiles the plan against the shared design tokens
//! (QA layer L2 invariants), executes the generated program in a sandboxed
//! frame, and resolves the waiter with the file bytes plus the full QA issue
//! list. Issues come back to the model as tool text so revision is an
//! in-turn plan patch — the compiled path's equivalent of the diagram
//! validator's self-correction loop.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use super::super::artifacts;
use super::super::tools::{ArtifactRef, ToolOutcome};

/// Wall-clock limit for the frontend compile+run (the runner enforces a
/// shorter watchdog of its own).
const GEN_TIMEOUT: Duration = Duration::from_secs(120);

/// Event the frontend `DocDesignRunner` listens for.
const COMPILE_EVENT: &str = "docdesign://compile";

struct PendingCompile {
    tx: oneshot::Sender<Result<CompiledDoc, String>>,
}

/// A successful compile: the produced file bytes plus the JSON-encoded QA
/// issue list from the frontend (L1 plan issues + L2 invariant results).
/// `payload_kind` is "html" when the bytes are HTML for the print engine
/// (pdf plans) rather than finished file bytes.
struct CompiledDoc {
    bytes: Vec<u8>,
    issues_json: Option<String>,
    payload_kind: Option<String>,
}

static PENDING: Lazy<parking_lot::Mutex<HashMap<String, PendingCompile>>> =
    Lazy::new(|| parking_lot::Mutex::new(HashMap::new()));

/// Formats the planner compiles: decks (PptxGenJS), documents (docx npm) and
/// PDF (HTML via the print engine) — each from the same plan-first contract.
pub fn is_supported(format: &str) -> bool {
    matches!(format, "pptx" | "docx" | "pdf")
}

/// Rust-side sanity check before the frontend round-trip: catch grossly
/// malformed plans cheaply so the steer happens without a window round-trip.
/// (Full validation is the frontend's L1, which owns the catalog.)
pub(crate) fn plan_sanity_errors(plan: &Value) -> Vec<String> {
    let mut errs = Vec::new();
    if !plan.is_object() {
        errs.push("plan must be a JSON object".to_string());
        return errs;
    }
    let kind = plan.get("kind").and_then(|v| v.as_str());
    if kind != Some("deck") && kind != Some("doc") {
        errs.push("plan.kind must be \"deck\" or \"doc\"".to_string());
    }
    match plan.get(if kind == Some("deck") { "slides" } else { "sections" }).and_then(|v| v.as_array()) {
        None => errs.push(if kind == Some("deck") { "plan.slides must be an array".to_string() } else { "plan.sections must be an array".to_string() }),
        Some(items) if items.is_empty() => errs.push(if kind == Some("deck") { "plan.slides must not be empty".to_string() } else { "plan.sections must not be empty".to_string() }),
        Some(_) => {}
    }
    errs
}

/// Parse the frontend QA issue list into (errors, warnings). Unknown shapes
/// degrade to zero issues rather than failing a successful generation.
pub(crate) fn parse_issues(issues_json: Option<&str>) -> (Vec<String>, Vec<String>) {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let Some(raw) = issues_json else {
        return (errors, warnings);
    };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw.trim()) else {
        return (errors, warnings);
    };
    for item in items {
        let severity = item.get("severity").and_then(|v| v.as_str()).unwrap_or("warning");
        let rule = item.get("rule").and_then(|v| v.as_str()).unwrap_or("qa");
        let message = item.get("message").and_then(|v| v.as_str()).unwrap_or("");
        if message.is_empty() {
            continue;
        }
        let line = format!("{rule}: {message}");
        if severity == "error" {
            errors.push(line);
        } else {
            warnings.push(line);
        }
    }
    (errors, warnings)
}

/// Entry point for the `plan_document` tool.
pub async fn plan_document(
    app: Option<&tauri::AppHandle>,
    artifacts_dir: &Path,
    args: &Value,
) -> ToolOutcome {
    let format = args
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let filename = args.get("filename").and_then(|v| v.as_str()).unwrap_or("");
    let theme = args
        .get("theme")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            args.get("plan")
                .and_then(|p| p.get("theme"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
    let plan = args.get("plan").cloned().unwrap_or(Value::Null);

    if filename.trim().is_empty() {
        return ToolOutcome::text("Error: plan_document requires a \"filename\".");
    }
    if !is_supported(&format) {
        return ToolOutcome::text(format!(
            "Error: plan_document supports pptx, docx and pdf (got \"{format}\"). For xlsx and \
             plain text formats, use generate_document or generate_file."
        ));
    }
    if plan.is_null() {
        return ToolOutcome::text(format!(
            "{PLAN_GUIDE}\n\nError: plan_document needs the deck plan JSON in the `plan` \
             argument. Author the plan (schema + layouts above) and re-call."
        ));
    }
    let sanity = plan_sanity_errors(&plan);
    if !sanity.is_empty() {
        return ToolOutcome::text(format!(
            "{PLAN_GUIDE}\n\nError: the plan is malformed:\n{}\nFix the plan and re-call.",
            sanity
                .iter()
                .map(|e| format!("  - {e}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    let Some(app) = app else {
        return ToolOutcome::text(
            "Error: plan_document needs the app window (unavailable in this headless run). \
             Fall back to generate_document with language=\"python\" instead.",
        );
    };
    let system = args
        .get("system")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    compile_and_write(
        app,
        &CompileJob {
            dir: artifacts_dir,
            format: &format,
            filename,
            theme,
            system,
            plan,
            tool: "plan_document",
        },
    )
    .await
}

/// Everything after the plan exists: compile round trip, write, render
/// probes, QA report, and the plan sidecar that `revise_document` patches
/// against. Shared by `plan_document` and `revise_document`.
struct CompileJob<'a> {
    dir: &'a Path,
    format: &'a str,
    filename: &'a str,
    theme: Option<String>,
    system: Option<String>,
    plan: Value,
    /// Tool name for error prefixes ("plan_document" / "revise_document").
    tool: &'a str,
}

async fn compile_and_write(app: &tauri::AppHandle, job: &CompileJob<'_>) -> ToolOutcome {
    let format = job.format;
    let plan = job.plan.clone();
    let Some(window) = app.get_webview_window("main") else {
        return ToolOutcome::text(format!(
            "Error: {} needs the app window (not available in this headless run). \
             Fall back to generate_document with language=\"python\" instead.",
            job.tool
        ));
    };

    if let Err(e) = std::fs::create_dir_all(job.dir) {
        return ToolOutcome::text(format!(
            "{} failed: could not create artifacts dir: {e}",
            job.tool
        ));
    }

    let out_path = planned_path(job.dir, format, job.filename);
    let name = out_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "deck.pptx".to_string());

    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<Result<CompiledDoc, String>>();
    PENDING.lock().insert(request_id.clone(), PendingCompile { tx });

    let emit_result = window.emit(
        COMPILE_EVENT,
        json!({
            "requestId": request_id,
            "format": format,
            "filename": name,
            "theme": job.theme,
            "system": job.system,
            "plan": plan,
        }),
    );
    if let Err(e) = emit_result {
        PENDING.lock().remove(&request_id);
        return ToolOutcome::text(format!("{} failed: could not reach the document compiler: {e}", job.tool));
    }

    // The frontend resolves the waiter with (bytes, issuesJson).
    let doc = match tokio::time::timeout(GEN_TIMEOUT, rx).await {
        Ok(Ok(Ok(doc))) if !doc.bytes.is_empty() => doc,
        Ok(Ok(Ok(_))) => {
            PENDING.lock().remove(&request_id);
            return ToolOutcome::text(format!(
                "{} failed: the compiler produced an empty file.",
                job.tool
            ));
        }
        Ok(Ok(Err(e))) => {
            PENDING.lock().remove(&request_id);
            let issues = take_issues(&request_id);
            let (errors, warnings) = parse_issues(issues.as_deref());
            return ToolOutcome::text(format_failure(&e, &errors, &warnings));
        }
        Ok(Err(_)) | Err(_) => {
            PENDING.lock().remove(&request_id);
            return ToolOutcome::text(format!(
                "{} failed: the document compiler did not answer within {}s \
                 (it may not be loaded in this window). Retry once, or fall back to \
                 generate_document.",
                job.tool,
                GEN_TIMEOUT.as_secs()
            ));
        }
    };
    PENDING.lock().remove(&request_id);

    let (errors, warnings) = parse_issues(doc.issues_json.as_deref());
    if !errors.is_empty() {
        // Paranoia: the runner should already have failed these in L1/L2.
        return ToolOutcome::text(format_failure(
            "the compiled document failed QA checks",
            &errors,
            &warnings,
        ));
    }

    // PDF plans deliver HTML (payload_kind "html") for the print engine;
    // everything else is finished file bytes.
    if doc.payload_kind.as_deref() == Some("html") {
        let html = match String::from_utf8(doc.bytes) {
            Ok(h) => h,
            Err(_) => {
                return ToolOutcome::text(format!(
                    "{} failed: compiler returned non-UTF-8 HTML.",
                    job.tool
                ))
            }
        };
        let title = plan.get("title").and_then(|v| v.as_str()).unwrap_or("Document");
        if let Err(e) = crate::chat::pdfprint::render_html_to_pdf(app, &html, &out_path, title).await {
            return ToolOutcome::text(format!(
                "{} failed: the PDF render engine reported: {e}. You can retry with \
                 generate_document (language=\"python\") which uses the ReportLab engine.",
                job.tool
            ));
        }
    } else if let Err(e) = std::fs::write(&out_path, &doc.bytes) {
        return ToolOutcome::text(format!("{} failed: could not write the document: {e}", job.tool));
    }

    // Plan sidecar for targeted revisions — kept hidden (never registered as
    // an artifact, never previewed).
    let sidecar = json!({
        "format": format,
        "theme": job.theme,
        "system": job.system,
        "filename": name,
        "plan": plan,
    });
    let mut sidecar_name = out_path.as_os_str().to_os_string();
    sidecar_name.push(".plan.json");
    let _ = std::fs::write(PathBuf::from(sidecar_name), sidecar.to_string());

    // L4 render probes + the QA report. Probes are best-effort: skipped or
    // failed probes degrade to report notes, never a failed generation.
    let mut report = super::qa::QaReport {
        passed: Vec::new(),
        warnings: warnings.clone(),
        probes: Vec::new(),
        page_count: 0,
        critic: "not-run (visual critique layer not wired to tool context)".to_string(),
    };
    if let Some(outcome) = super::qa::run_render_probes(app, &out_path, format).await {
        report.page_count = outcome.page_count;
        report.probes = outcome.issues;
        if outcome.skipped {
            report.warnings.push("probe: render probes skipped — document saved unprobed".to_string());
        }
    } else {
        report.probes.push("probe: render probes unavailable (no window or timeout)".to_string());
    }

    let _ = app.emit(
        super::qa::DOC_QA_EVENT,
        report.event_payload(&out_path, &name),
    );

    ToolOutcome {
        text: format_success(&name, &out_path, &report),
        artifact: Some(ArtifactRef {
            path: out_path.display().to_string(),
            filename: name,
        }),
        browse_url: None,
        preview: None,
    }
}

/// Entry point for the `revise_document` tool: targeted, slot-level edits to
/// a document previously produced by `plan_document`. Loads the plan sidecar,
/// applies the patches to the PLAN (not the file), and re-runs the same
/// compile + QA pipeline — so every revision keeps the design guarantees.
pub async fn revise_document(
    app: Option<&tauri::AppHandle>,
    _artifacts_dir: &Path,
    args: &Value,
) -> ToolOutcome {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.trim().is_empty() {
        return ToolOutcome::text("Error: revise_document requires the artifact \"path\" (from the original plan_document result).");
    }
    let Some(patches) = args.get("patches").and_then(|v| v.as_array()) else {
        return ToolOutcome::text(format!(
            "{REVISE_GUIDE}\n\nError: revise_document needs a \"patches\" array."
        ));
    };

    // The sidecar is stored as "<full filename>.plan.json" next to the file.
    let appended = format!("{path}.plan.json");
    let sidecar_path = std::path::PathBuf::from(&appended);
    if !sidecar_path.exists() {
        return ToolOutcome::text(format!(
            "Error: no plan sidecar found next to {path}. revise_document works on documents \
             created by plan_document; for other files, edit them directly or regenerate."
        ));
    }
    let sidecar: Value = match std::fs::read_to_string(&sidecar_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => v,
        None => {
            return ToolOutcome::text(format!(
                "Error: the plan sidecar next to {path} is unreadable. Regenerate the document \
                 with plan_document instead."
            ))
        }
    };

    let format = sidecar.get("format").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let filename = sidecar
        .get("filename")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let theme = sidecar
        .get("theme")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let system = sidecar
        .get("system")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let mut plan = sidecar.get("plan").cloned().unwrap_or(Value::Null);

    let applied = apply_patches(&mut plan, patches);
    if let Err(e) = applied {
        return ToolOutcome::text(format!(
            "{REVISE_GUIDE}\n\nError: the patches could not be applied:\n  - {e}\nFix the \
             patches and re-call."
        ));
    }
    let applied = applied.unwrap_or(0);

    let sanity = plan_sanity_errors(&plan);
    if !sanity.is_empty() {
        return ToolOutcome::text(format!(
            "Error: patching left the plan malformed:\n{}\nRe-call with corrected patches.",
            sanity
                .iter()
                .map(|e| format!("  - {e}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    let Some(app) = app else {
        return ToolOutcome::text(
            "Error: revise_document needs the app window (unavailable in this headless run).",
        );
    };
    let dir = Path::new(path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();

    let mut outcome = compile_and_write(
        app,
        &CompileJob {
            dir: &dir,
            format: &format,
            filename: &filename,
            theme,
            system,
            plan,
            tool: "revise_document",
        },
    )
    .await;
    outcome.text = format!("Applied {applied} patch(es).\n\n{}", outcome.text);
    outcome
}

/// Pure patch application. Deck patches address `{"slide": id, "slot": id,
/// "value": …}` (slot wholesale) or `{"slide": id, "notes": "…"}`. Document
/// patches address `{"section": id, "heading": "…"}`, `{"section": id,
/// "block": index, "value": …}` (string → block text; object → whole block)
/// or `{"section": id, "block": index, "remove": true}`. Returns the number
/// of patches applied.
pub(crate) fn apply_patches(plan: &mut Value, patches: &[Value]) -> Result<usize, String> {
    let mut applied = 0usize;
    for (i, patch) in patches.iter().enumerate() {
        let why = format!("patch {i}");
        let obj = patch
            .as_object()
            .ok_or_else(|| format!("{why}: must be an object"))?;
        let value = obj.get("value");

        if let Some(slide_id) = obj.get("slide").and_then(|v| v.as_str()) {
            let slide = plan
                .get_mut("slides")
                .and_then(|v| v.as_array_mut())
                .ok_or_else(|| format!("{why}: plan has no slides array"))?
                .iter_mut()
                .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(slide_id))
                .ok_or_else(|| format!("{why}: no slide with id \"{slide_id}\""))?;
            if let Some(notes) = obj.get("notes").and_then(|v| v.as_str()) {
                slide["notes"] = json!(notes);
                applied += 1;
                continue;
            }
            let slot = obj
                .get("slot")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("{why}: slide patch needs \"slot\" (or \"notes\")"))?;
            let value = value.ok_or_else(|| format!("{why}: missing \"value\""))?;
            slide["slots"][slot] = value.clone();
            applied += 1;
            continue;
        }

        if let Some(section_id) = obj.get("section").and_then(|v| v.as_str()) {
            let section = plan
                .get_mut("sections")
                .and_then(|v| v.as_array_mut())
                .ok_or_else(|| format!("{why}: plan has no sections array"))?
                .iter_mut()
                .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(section_id))
                .ok_or_else(|| format!("{why}: no section with id \"{section_id}\""))?;
            if let Some(heading) = obj.get("heading").and_then(|v| v.as_str()) {
                section["heading"] = json!(heading);
                applied += 1;
                continue;
            }
            let block_idx = obj
                .get("block")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| format!("{why}: section patch needs \"block\" (or \"heading\")"))?
                as usize;
            let blocks = section
                .get_mut("blocks")
                .and_then(|v| v.as_array_mut())
                .ok_or_else(|| format!("{why}: section \"{section_id}\" has no blocks"))?;
            if block_idx >= blocks.len() {
                return Err(format!(
                    "{why}: block index {block_idx} out of range (section has {} blocks)",
                    blocks.len()
                ));
            }
            if obj.get("remove").and_then(|v| v.as_bool()) == Some(true) {
                blocks.remove(block_idx);
                applied += 1;
                continue;
            }
            let value = value.ok_or_else(|| format!("{why}: missing \"value\""))?;
            if let Some(text) = value.as_str() {
                // Convenience: replace the block's text in place — check the
                // block type BEFORE mutating.
                let block_type = blocks[block_idx]
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if block_type != "paragraph" && block_type != "callout" && block_type != "quote" {
                    return Err(format!(
                        "{why}: string value patches the text of paragraph/callout/quote blocks \
                         — pass a whole block object for type \"{block_type}\""
                    ));
                }
                blocks[block_idx]["text"] = json!(text);
            } else {
                blocks[block_idx] = value.clone();
            }
            applied += 1;
            continue;
        }

        return Err(format!(
            "{why}: needs a \"slide\" or \"section\" target"
        ));
    }
    if applied == 0 {
        return Err("no patches were applied (empty patch list?)".to_string());
    }
    Ok(applied)
}

/// Guidance for targeted revisions (progressive disclosure — returned with
/// errors only).
pub(crate) const REVISE_GUIDE: &str = "DOCUMENT REVISION — patch the PLAN, not the file. \
patches: [{ \"slide\": \"s3\", \"slot\": \"title\", \"value\": \"New title\" } | \
{ \"slide\": \"s3\", \"notes\": \"…\" } | { \"section\": \"sec2\", \"heading\": \"…\" } | \
{ \"section\": \"sec2\", \"block\": 1, \"value\": \"replacement text\" } | \
{ \"section\": \"sec2\", \"block\": 2, \"value\": {whole block object}, … } | \
{ \"section\": \"sec2\", \"block\": 3, \"remove\": true }]. The document is recompiled \
and re-validated after patching; budget/validation errors come back if a patch \
overflows its slot.";

/// Per-request issue payloads parked by `complete` until the waiter reads
/// them (the IPC command carries bytes and issues separately; on the failure
/// path there are no bytes, so the issues must live here).
static LAST_ISSUES: Lazy<parking_lot::Mutex<HashMap<String, String>>> =
    Lazy::new(|| parking_lot::Mutex::new(HashMap::new()));

fn stash_issues(request_id: &str, issues: Option<String>) {
    if let Some(json) = issues {
        LAST_ISSUES.lock().insert(request_id.to_string(), json);
    }
}

fn take_issues(request_id: &str) -> Option<String> {
    LAST_ISSUES.lock().remove(request_id)
}

/// Resolve a pending compile — called by the `docdesign_complete` IPC command.
pub fn complete(
    request_id: &str,
    result: Result<Vec<u8>, String>,
    issues: Option<String>,
    payload_kind: Option<String>,
) {
    stash_issues(request_id, issues);
    if let Some(run) = PENDING.lock().remove(request_id) {
        let payload = result.map(|bytes| CompiledDoc {
            bytes,
            issues_json: take_issues(request_id),
            payload_kind,
        });
        let _ = run.tx.send(payload);
    }
}

fn planned_path(dir: &Path, format: &str, filename: &str) -> PathBuf {
    let ext = artifacts::canonical_ext(format);
    let base = artifacts::sanitize_filename(filename);
    let name = if base.to_lowercase().ends_with(&format!(".{ext}")) {
        base
    } else {
        format!("{base}.{ext}")
    };
    dir.join(name)
}

fn format_failure(error: &str, errors: &[String], warnings: &[String]) -> String {
    let mut text = format!(
        "{PLAN_GUIDE}\n\nplan_document failed: {error}\n\nFix the issues below by calling \
         plan_document again with a REVISED plan (same filename overwrites):\n"
    );
    for e in errors {
        text.push_str(&format!("  - {e}\n"));
    }
    for w in warnings {
        text.push_str(&format!("  - (warning) {w}\n"));
    }
    if errors.is_empty() && warnings.is_empty() {
        text.push_str("  - (no structured issues returned; see the error above)\n");
    }
    text
}

fn format_success(filename: &str, path: &Path, report: &crate::chat::docdesign::qa::QaReport) -> String {
    let mut text = format!(
        "Created \"{filename}\" ({path}) via the plan compiler: the plan passed \
         layout/budget validation and the compiled program passed all design invariants \
         (bare hex, native charts, token fonts, single save). It is saved and visible to \
         the user in the preview pane.",
        filename = filename,
        path = path.display()
    );
    text.push_str(&format!("\n\n{}", report.summary_line()));
    for w in &report.warnings {
        text.push_str(&format!("\n  - {w}"));
    }
    for p in &report.probes {
        text.push_str(&format!("\n  - (probe) {p}"));
    }
    if !report.is_clean() {
        text.push_str(
            "\nIf any warning affects readability, re-call plan_document with a revised plan \
             (same filename overwrites).",
        );
    }
    text.push_str(
        "\n\nTo change the document, revise the PLAN (not raw code) and re-call \
         plan_document with the same filename — it overwrites in place.",
    );
    text
}

/// Planner guidance, returned with steer errors (progressive disclosure — the
/// system prompt carries only the tool description).
pub(crate) const PLAN_GUIDE: &str = "\
DECK PLANNER — author the deck as a plan JSON in `plan`, not as code. The \
compiler applies the shared design system (tokens, layouts, budgets); you own \
CONTENT only. Schema:
{ \"v\": 1, \"kind\": \"deck\", \"title\": str, \"theme\": \"ink|midnight|emerald|plum|amber|crimson|teal\", \"slides\": [...] }
Each slide: { \"id\": \"s1\", \"layout\": str, \"slots\": {...}, \"notes\": str }
LAYOUTS (slots → budgets):
  cover      — title(60c, req), subtitle, meta                      [dark]
  section    — title(50c, req), kicker (e.g. \"01 — Context\")       [dark]
  agenda     — title(req), items[≤7 × 90c]
  bullets    — title(req), eyebrow, bullets[≤6 × 110c]
  two-col    — title(req), leftTitle+leftBullets[≤5], rightTitle+rightBullets[≤5]
  chart-text — title(req), chart(req), body(≤450c), source
  chart-full — title(req), chart(req), source
  kpi        — title(req), kips exactly 3 × {label, value(≤10c), delta?, trend?}, source
  quote      — quote(≤240c, req), attribution
  timeline   — title(req), steps[2–4 × {label(≤40c), caption(≤120c)}]
  table      — title(req), table rows[≤8, header first, 2–5 cols], source
  statement  — statement(≤140c, req), context
  closing    — title(req), contact                                  [dark]
chart: { \"type\": \"bar|line|pie\", \"labels\": [str], \"series\": [{\"name\", \"values\": [num]}] } — values length must equal labels; native, editable charts.
RULES: open with cover, close with closing; ≤3 consecutive identical layouts; \
action titles that state the takeaway (\"Burn crossed target twice\", not \
\"Chart of burn\"); one message per slide; real content (8–14 slides for a \
review deck); notes on content slides.
DOCUMENT PLANS (format: docx|pdf) use { v: 1, kind: [doc], title, subtitle?,
author?, sections: [{ id, heading, blocks: [...] }] }. Block types: paragraph
(<=1500c), bullets/numbered (<=8 x 250c), callout (<=300c), quote (<=450c + attribution),
table (2-6 cols x <=20 rows, header row via columns), kpi-strip (2-4 stats). Reports:
3-7 sections with informative headings, a callout carrying each section takeaway where
natural, sources cited on tables. Example slide:
{ \"id\": \"s2\", \"layout\": \"kpi\", \"slots\": { \"title\": \"Quarter at a glance\", \"kpis\": \
[{ \"label\": \"Uptime\", \"value\": \"99.96%\", \"delta\": \"+0.04 pp\", \"trend\": \"up\" }, ...] } }";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_formats_match_the_compiled_path() {
        assert!(is_supported("pptx"));
        assert!(is_supported("docx"));
        assert!(is_supported("pdf"));
        assert!(!is_supported("xlsx"));
        assert!(!is_supported("doc"));
    }

    #[test]
    fn sanity_catches_malformed_plans() {
        assert!(!plan_sanity_errors(&json!({"kind": "doc", "slides": [{"id": "s1"}]})).is_empty());
        assert!(!plan_sanity_errors(&json!({"kind": "deck", "slides": []})).is_empty());
        assert!(!plan_sanity_errors(&json!({"kind": "deck"})).is_empty());
        assert!(!plan_sanity_errors(&json!("a deck about things")).is_empty());
        assert!(plan_sanity_errors(&json!({"kind": "deck", "slides": [{"id": "s1", "layout": "cover"}]})).is_empty());
    }

    #[test]
    fn issues_parse_into_errors_and_warnings() {
        let (errors, warnings) = parse_issues(Some(
            r#"[{"severity":"error","rule":"catalog","message":"unknown layout x","pointer":"slides[0]"},
                {"severity":"warning","rule":"coherence","message":"no cover"}]"#,
        ));
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("unknown layout x"));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("no cover"));

        let (errors, warnings) = parse_issues(None);
        assert!(errors.is_empty() && warnings.is_empty());
        let (errors, warnings) = parse_issues(Some("garbage"));
        assert!(errors.is_empty() && warnings.is_empty());
        let (errors, warnings) = parse_issues(Some(r#"[{"message":""}]"#));
        assert!(errors.is_empty() && warnings.is_empty());
    }

    #[test]
    fn planned_paths_add_extension() {
        let dir = Path::new("C:\\artifacts");
        assert_eq!(planned_path(dir, "pptx", "Review"), dir.join("Review.pptx"));
        assert_eq!(planned_path(dir, "pptx", "deck.pptx"), dir.join("deck.pptx"));
    }

    #[test]
    fn success_text_narrates_warnings_and_revision_protocol() {
        let clean = crate::chat::docdesign::qa::QaReport {
            passed: vec!["a".to_string(), "b".to_string()],
            ..Default::default()
        };
        let text = format_success("Review.pptx", Path::new("C:\\artifacts\\Review.pptx"), &clean);
        assert!(text.contains("plan compiler"));
        assert!(text.contains("clean"));
        assert!(text.contains("2 check(s)"));

        let flagged = crate::chat::docdesign::qa::QaReport {
            warnings: vec!["coherence: no cover".to_string()],
            probes: vec!["probe/overflow: page 2".to_string()],
            ..Default::default()
        };
        let text = format_success("Review.pptx", Path::new("C:\\artifacts\\Review.pptx"), &flagged);
        assert!(text.contains("2 warning(s)"));
        assert!(text.contains("(probe) probe/overflow"));
        assert!(text.contains("revised plan"));
    }

    #[test]
    fn failure_text_carries_the_guide_and_issues() {
        let text = format_failure(
            "plan validation failed",
            &["catalog: unknown layout x".to_string()],
            &["coherence: no closing".to_string()],
        );
        assert!(text.contains("DECK PLANNER"));
        assert!(text.contains("- catalog: unknown layout x"));
        assert!(text.contains("- (warning) coherence: no closing"));
        assert!(text.contains("REVISED plan"));
    }

    #[test]
    fn guide_covers_document_plans() {
        assert!(PLAN_GUIDE.contains("DOCUMENT PLANS"));
        assert!(PLAN_GUIDE.contains("kpi-strip"));
        assert!(PLAN_GUIDE.contains("attribution"));
    }

    #[test]
    fn guide_lists_every_layout_and_budget_rule() {
        for layout in [
            "cover", "section", "agenda", "bullets", "two-col", "chart-text",
            "chart-full", "kpi", "quote", "timeline", "table", "statement", "closing",
        ] {
            assert!(PLAN_GUIDE.contains(layout), "guide missing layout {layout}");
        }
        assert!(PLAN_GUIDE.contains("exactly 3"));
        assert!(PLAN_GUIDE.contains("≤3 consecutive"));
    }

    #[test]
    fn patches_address_deck_slots() {
        let mut plan = json!({
            "v": 1, "kind": "deck", "title": "T",
            "slides": [
                {"id": "s1", "layout": "cover", "slots": {"title": "Old"}},
                {"id": "s2", "layout": "bullets", "slots": {"title": "Keep", "bullets": ["a"]}}
            ]
        });
        let n = apply_patches(
            &mut plan,
            &[
                json!({"slide": "s1", "slot": "title", "value": "New"}),
                json!({"slide": "s2", "slot": "bullets", "value": ["x", "y"]}),
                json!({"slide": "s2", "notes": "speaker notes"}),
            ],
        )
        .unwrap();
        assert_eq!(n, 3);
        assert_eq!(plan["slides"][0]["slots"]["title"], json!("New"));
        assert_eq!(plan["slides"][1]["slots"]["bullets"], json!(["x", "y"]));
        assert_eq!(plan["slides"][1]["notes"], json!("speaker notes"));
    }

    #[test]
    fn patches_address_document_blocks() {
        let mut plan = json!({
            "v": 1, "kind": "doc", "title": "T",
            "sections": [
                {"id": "sec1", "heading": "Old heading", "blocks": [
                    {"type": "paragraph", "text": "before"},
                    {"type": "table", "columns": ["a"], "rows": [["x"]]}
                ]}
            ]
        });
        let n = apply_patches(
            &mut plan,
            &[
                json!({"section": "sec1", "heading": "New heading"}),
                json!({"section": "sec1", "block": 0, "value": "after"}),
                json!({"section": "sec1", "block": 1, "remove": true}),
            ],
        )
        .unwrap();
        assert_eq!(n, 3);
        assert_eq!(plan["sections"][0]["heading"], json!("New heading"));
        assert_eq!(plan["sections"][0]["blocks"][0]["text"], json!("after"));
        assert_eq!(plan["sections"][0]["blocks"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn patches_reject_bad_targets() {
        let mut plan = json!({
            "v": 1, "kind": "deck", "title": "T",
            "slides": [{"id": "s1", "layout": "cover", "slots": {}}]
        });
        // unknown slide
        assert!(apply_patches(&mut plan, &[json!({"slide": "zz", "slot": "title", "value": "x"})]).is_err());
        // missing slot
        assert!(apply_patches(&mut plan, &[json!({"slide": "s1", "value": "x"})]).is_err());
        // wrong target shape
        assert!(apply_patches(&mut plan, &[json!({"value": "x"})]).is_err());
        // empty patch list
        assert!(apply_patches(&mut plan, &[]).is_err());
        // string value against a non-text block (bullets need the array form)
        let mut doc_plan = json!({
            "v": 1, "kind": "doc", "title": "T",
            "sections": [{"id": "s", "heading": "H", "blocks": [
                {"type": "bullets", "items": ["a"]}
            ]}]
        });
        let err = apply_patches(&mut doc_plan, &[json!({"section": "s", "block": 0, "value": "text"})]);
        assert!(err.is_err());
    }

    #[test]
    fn revise_guide_documents_the_patch_shapes() {
        assert!(REVISE_GUIDE.contains("slide"));
        assert!(REVISE_GUIDE.contains("slot"));
        assert!(REVISE_GUIDE.contains("section"));
        assert!(REVISE_GUIDE.contains("remove"));
    }

    #[test]
    fn complete_without_waiter_is_ignored() {
        // Late double-completions and stale frames must not panic.
        complete("no-such-request", Ok(b"x".to_vec()), None, None);
    }
}
