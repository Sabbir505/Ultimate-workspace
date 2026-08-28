//! File/document/diagram generation tools: `generate_file` (plain text),
//! `generate_document` (docx/pptx/xlsx/pdf via the bundled Python runtime),
//! and `generate_diagram` (inline-SVG HTML). Each produces a file surfaced to
//! the UI as a downloadable artifact. Diagram HTML is structurally validated
//! before write ([`validate_diagram_html`]) and prefixed with the
//! [`DIAGRAM_MARKER`] sentinel so the preview pane can detect it.

use std::path::Path;

use serde_json::Value;

use crate::chat::artifacts;
use super::{ArtifactRef, ToolOutcome};

pub(super) fn generate_file(artifacts_dir: &Path, args: &Value) -> ToolOutcome {
    let format = args
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let filename = args.get("filename").and_then(|v| v.as_str()).unwrap_or("");
    let title = args.get("title").and_then(|v| v.as_str());
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");

    if !artifacts::is_supported(&format) {
        return ToolOutcome::text(format!(
            "Error: generate_file does not support format \"{format}\"."
        ));
    }
    if filename.trim().is_empty() {
        return ToolOutcome::text("Error: generate_file requires a \"filename\".");
    }

    match artifacts::generate(artifacts_dir, &format, filename, title, content) {
        Ok(file) => ToolOutcome {
            text: format!(
                "Created file \"{}\" ({}). It has been saved and is available to the user.",
                file.filename,
                file.path.display()
            ),
            artifact: Some(ArtifactRef {
                path: file.path.display().to_string(),
                filename: file.filename,
            }),
            browse_url: None,
            preview: None,
        },
        Err(e) => ToolOutcome::text(format!("generate_file failed: {e}")),
    }
}

/// Editorial style guide shared by every document engine. Lives HERE (not in
/// the tool schema) so fresh turns don't pay ~3k chars of guidance until the
/// tool is actually used — progressive disclosure.
pub(super) const DOC_STYLE_GUIDE: &str = "\
DOCUMENT STYLE GUIDE — aim for the editorial, modern look Claude/ChatGPT/Gemini \
ship: an elegant serif display face paired with a clean sans body, generous \
whitespace, a strong type hierarchy, ONE restrained accent colour, and rich \
full-bleed cover/section slides. Hierarchy comes from type scale, weight and \
whitespace — NEVER decorative accent bars, stripes, or underlines under titles. \
Clean white pages for documents; save saturated colour for deck cover/section/\
closing slides. Cover/title, real typography, headings, tables; decks get \
multiple well-laid-out slides with a title slide and section dividers. Build \
genuinely useful content (several sections or 6+ slides). No secrets, no \
network side effects. If the document you just built falls short of this \
guide, regenerate it now.";

/// Engine guide for `language: "javascript"` (docx / pptx). The default for
/// docx+pptx: no Python dependency, works on every OS, and produces real
/// editable OOXML (the same engines Anthropic's public document skills use).
pub(super) const JS_DOCGEN_GUIDE: &str = "\
JS DOCGEN — for docx and pptx, write JavaScript for `language:\"javascript\"`. \
The code runs in the app's document sandbox with `docx` (Word) and \
`PptxGenJS` (PowerPoint) preloaded and a `conduit` helper. Deliver the file \
with EXACTLY ONE `await conduit.save(blobOrBytesOrDataUrl)`.
DOCX (docx npm):
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, \
TableCell, AlignmentType } = docx;
  const doc = new Document({ sections: [{ children: [ \
new Paragraph({ text: 'Title', heading: HeadingLevel.HEADING_1 }), \
new Paragraph(new TextRun({ text: 'Body', bold: true })), \
new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('Cell')] })] })] }) \
] }] });
  await conduit.save(await Packer.toBlob(doc));
  Headings MUST use HeadingLevel (real Word styles); lists: \
new Paragraph({ text:'x', bullet:{level:0} }) or numbering.
PPTX (PptxGenJS):
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'W', width: 13.33, height: 7.5 }); pptx.layout = 'W';
  pptx.defineSlideMaster({ title: 'M', background: { color: '0B1220' } });
  const s = pptx.addSlide({ masterName: 'M' });
  s.addText('Title', { x: 0.6, y: 0.5, w: 12, h: 1, fontSize: 40, bold: true, color: 'FFFFFF' });
  s.addChart(pptx.ChartType.bar, [{ name: 'Rev', labels: ['Q1','Q2'], values: [4, 6] }], \
{ x: 0.6, y: 1.8, w: 6, h: 4 });
  await conduit.save(await pptx.write({ outputType: 'blob' }));
  Gotchas: hex colors WITHOUT '#' (use '0B1220' not '#0B1220' — a '#' corrupts \
the file); always set a 16:9 layout (defineLayout) because the default is 10x5.63in; \
fonts/sizes on every addText call. If generation fails, retry once with \
language:\"python\".";

/// Engine guide for `language: "html"` (pdf). Browser-grade fidelity via the
/// app's hidden WebView2 print engine + Paged.js (@page, page numbers,
/// running headers, TOC page refs) — full Unicode/CJK/web-font support.
pub(super) const HTML_PDF_GUIDE: &str = "\
HTML→PDF — for pdf, write a complete styled HTML document in `code` with \
`language:\"html\"`. It is rendered by a real browser engine and printed to \
PDF; CSS, SVG, images (inline data URIs), tables, flex/grid ALL work, and any \
Unicode language renders correctly. Rules: inline all CSS in <style> tags (no \
external <link>/<script>); page structure comes from @page — e.g. \
@page { size: A4; margin: 20mm; @bottom-center { content: counter(page); } } \
(Paged.js is preloaded, so margin boxes/page counters work); use \
break-before: page for section starts; full-bleed cover: @page:first with \
margin 0 and a full-height cover div. Keep it a polished editorial document \
(serif display + sans body, one accent colour, generous whitespace).";

/// Layout guide for `generate_diagram` — same progressive-disclosure contract
/// as DOC_STYLE_GUIDE. Routes each visual job to the format that renders it
/// with the highest fidelity (Claude-style): auto-layouted Mermaid for graph
/// diagrams, React+Recharts for charts, single-file HTML for interactive
/// explainers, hand-authored SVG only for freeform static art.
pub(super) const DIAGRAM_STYLE_GUIDE: &str = "\
VISUAL ROUTING — pick the format by job, not habit:
1. Flowcharts, sequence, ER, state, journey or git-graph diagrams: write a ```mermaid \
block (or a .mmd file) instead of hand-positioning boxes — Mermaid auto-layouts \
nodes/edges and always comes out clean. Reserve generate_diagram for freeform \
static illustration (concept art of an architecture, annotated sketches).
2. Charts and dashboards (bar/line/pie/area/scatter, KPI panels): create a .tsx \
file via write_file — the preview sandbox ships pre-installed recharts, d3 and \
lucide-react (import { LineChart, BarChart, PieChart, XAxis, ... } from \"recharts\"; \
import { Camera } from \"lucide-react\"), so compose real components instead of \
drawing axes by hand. Default-export the dashboard component.
3. Interactive explainers (sliders, buttons, step-through demos): a single-file \
HTML page via write_file — HTML+CSS+JS in one file, controls fully wired, and if \
you need a library load it ONLY from https://cdnjs.cloudflare.com (the preview \
sandbox blocks every other external host).
4. generate_diagram (inline-SVG HTML): freeform static vector art only. Follow \
the layout guide below and keep the SVG pure (no <script>/<iframe> — the preview \
sandbox strips them). \
Deliberate visual hierarchy: nested groupings/containers, a 2-D grid of sub-nodes \
(not a single row), mixed box sizes, bold-label-plus-dim-description two-line nodes, \
solid primary-flow arrows with a dashed feedback line looping back, and consistent \
colour per category. Put the title as a <text> at the top of the SVG, above the flow. \
If the diagram you just built looks flat or linear, regenerate it with this guide applied.

SHOWING YOUR WORK — the app handles it: every file you create with write_file is \
previewed automatically (rendered inline in the chat or opened as a preview tab — \
HTML runs live, .mmd renders as a diagram, .md renders with diagrams, .tsx runs as \
a live React app). Therefore: ALWAYS create files with write_file (never paste full \
file contents into the chat), and NEVER start a local server, spin up a static \
server, or call open_url/browser to show a file you just created — telling the user \
\"I created X\" is enough; the preview appears on its own. Markdown files preview \
with full formatting in the pane too, so never claim a .md can't be opened.";

/// The engine table for `generate_document`, by format and `language`.
/// docx/pptx default to the cross-platform JavaScript engine (docx npm /
/// PptxGenJS); pdf defaults to the HTML print engine (browser-grade layout,
/// real Unicode); xlsx stays Python/openpyxl. "python" remains available for
/// every format as the fallback engine (bundled interpreter).
fn default_language(format: &str) -> &'static str {
    match format {
        "pdf" => "html",
        "docx" | "pptx" => "javascript",
        _ => "python",
    }
}

/// Build a rich document by running the model's program with the engine the
/// model chose: JavaScript (docx npm / PptxGenJS, via the in-app runner),
/// HTML (PDF via the hidden WebView2 print engine), or Python (python-docx /
/// python-pptx / openpyxl / reportlab on the bundled interpreter).
pub(super) async fn generate_document(
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
    let code = args.get("code").and_then(|v| v.as_str()).unwrap_or("");
    let language = match args.get("language").and_then(|v| v.as_str()) {
        Some("javascript" | "js") => "javascript",
        Some("html") => "html",
        Some("python" | "py") => "python",
        _ => default_language(&format),
    };

    let supported = matches!(format.as_str(), "docx" | "pptx" | "xlsx" | "pdf");
    if !supported {
        return ToolOutcome::text(format!(
            "Error: generate_document supports docx, pptx, xlsx and pdf (got \"{format}\"). \
             Use generate_file for plain text formats."
        ));
    }
    if filename.trim().is_empty() {
        return ToolOutcome::text("Error: generate_document requires a \"filename\".");
    }

    // Engine-specific validation for the requested route; anything invalid
    // steers the model back with the matching guide instead of failing
    // silently (the #1 source of abandoned document turns).
    let instructions = args
        .get("instructions")
        .or_else(|| args.get("description"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if code.trim().is_empty() {
        let (engine_hint, guide) = match language {
            "html" => (
                "a complete styled HTML document",
                HTML_PDF_GUIDE,
            ),
            "javascript" => (
                "a complete JavaScript program (uses the preloaded `docx` / `PptxGenJS` \
                 globals and `await conduit.save(...)`)",
                JS_DOCGEN_GUIDE,
            ),
            _ => (
                "a complete Python program that saves the file to os.environ[\"CONDUIT_OUTPUT\"]",
                DOC_STYLE_GUIDE,
            ),
        };
        let steer = if instructions.trim().is_empty() {
            format!(
                "{guide}\n\nError: generate_document needs runnable source in the `code` \
                 argument for language=\"{language}\" — pass {engine_hint}."
            )
        } else {
            format!(
                "{guide}\n\nError: generate_document received a natural-language description \
                 in `instructions` instead of runnable {language} source in `code`. Re-call \
                 with `code` set to {engine_hint}. Requested: {instructions}"
            )
        };
        return ToolOutcome::text(steer);
    }

    // Window-backed engines need an AppHandle (absent in unit tests and
    // headless runs); they degrade to a Python-fallback hint rather than a
    // dead end.
    let no_app = || {
        Err("the selected engine needs the app window, which is unavailable in this \
             headless run. Re-run with language=\\\"python\\\" to use the bundled Python \
             engine instead."
            .to_string())
    };
    let result = match language {
        "html" if format == "pdf" => match app {
            Some(a) => generate_pdf_from_html(a, artifacts_dir, filename, code).await,
            None => no_app(),
        },
        "javascript" if matches!(format.as_str(), "docx" | "pptx") => match app {
            Some(a) => crate::chat::jsdocgen::generate(a, artifacts_dir, &format, filename, code).await,
            None => no_app(),
        },
        "python" => crate::chat::pygen::generate(artifacts_dir, &format, filename, code).await,
        // Engine/format mismatches (e.g. html for pptx) fall back to the
        // default engine for that format rather than failing the turn.
        _ => match default_language(&format) {
            "html" => match app {
                Some(a) => generate_pdf_from_html(a, artifacts_dir, filename, code).await,
                None => no_app(),
            },
            "javascript" => match app {
                Some(a) => crate::chat::jsdocgen::generate(a, artifacts_dir, &format, filename, code).await,
                None => no_app(),
            },
            _ => crate::chat::pygen::generate(artifacts_dir, &format, filename, code).await,
        },
    };

    let engine_guide = match language {
        "html" => HTML_PDF_GUIDE,
        "javascript" => JS_DOCGEN_GUIDE,
        _ => DOC_STYLE_GUIDE,
    };

    match result {
        Ok(file) => {
            let mut text = format!(
                "{engine_guide}\n\nCreated document \"{}\" ({}). It has been saved and is available to the user.",
                file.filename,
                file.path.display()
            );
            if !file.log.trim().is_empty() && file.log.trim() != "generated with the in-app JavaScript engine (docx / PptxGenJS)" {
                text.push_str(&format!("\n\nGenerator output:\n{}", file.log));
            }
            ToolOutcome {
                text,
                artifact: Some(ArtifactRef {
                    path: file.path.display().to_string(),
                    filename: file.filename,
                }),
                browse_url: None,
                preview: None,
            }
        }
        Err(e) => {
            let fallback = if language == "python" {
                String::new()
            } else {
                "\n\nYou can retry with language:\"python\" (bundled Python engine) if the \
                 problem persists."
                    .to_string()
            };
            ToolOutcome::text(format!("generate_document failed: {e}{fallback}"))
        }
    }
}

/// Render a model-authored HTML document to PDF with the hidden WebView2
/// print engine (see `pdfprint`), writing to the requested artifact path.
async fn generate_pdf_from_html(
    app: &tauri::AppHandle,
    artifacts_dir: &Path,
    filename: &str,
    html: &str,
) -> Result<crate::chat::pygen::Generated, String> {
    let path = crate::chat::jsdocgen::planned_path(artifacts_dir, "pdf", filename);
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "document.pdf".to_string());
    let title = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Document".to_string());
    crate::chat::pdfprint::render_html_to_pdf(app, html, &path, &title).await?;
    Ok(crate::chat::pygen::Generated {
        path,
        filename: name,
        log: String::new(),
    })
}

/// Sentinel HTML comment prepended to every diagram file. The preview
/// classifier (`read_artifact_preview`) looks for it to route the file as
/// `kind: "diagram"` (diagram-specific export chrome) instead of generic
/// `html`. It is harmless when the file is opened directly in a browser.
pub const DIAGRAM_MARKER: &str = "<!-- conduit:diagram -->";

/// Build a hand-styled HTML/CSS diagram file. The model supplies the full
/// HTML document; we prepend the diagram sentinel marker (so the preview pane
/// can route it as `kind: "diagram"`), write it to the artifacts dir, and run
/// a lightweight structural check whose result is fed back to the model.
pub(super) fn generate_diagram(artifacts_dir: &Path, args: &Value) -> ToolOutcome {
    let filename = args.get("filename").and_then(|v| v.as_str()).unwrap_or("");
    let html = args.get("html").and_then(|v| v.as_str()).unwrap_or("");

    if filename.trim().is_empty() {
        return ToolOutcome::text("Error: generate_diagram requires a \"filename\".");
    }
    if html.trim().is_empty() {
        return ToolOutcome::text("Error: generate_diagram requires non-empty \"html\".");
    }

    // Prepend the sentinel marker as the very first bytes of the file: the
    // preview classifier (`read_artifact_preview`) detects diagrams via
    // `starts_with(DIAGRAM_MARKER)`. A leading HTML comment does not affect
    // doctype-based standards-mode parsing in modern browsers.
    let body = prepend_diagram_marker(html);

    // Reuse the artifacts writer with the `html` format so we get the same
    // filename-sanitization, extension-handling, and dir-creation behavior.
    let file = match artifacts::generate(artifacts_dir, "html", filename, None, &body) {
        Ok(f) => f,
        Err(e) => return ToolOutcome::text(format!("generate_diagram failed: {e}")),
    };

    let report = validate_diagram_html(html);
    let note = if report.is_clean() {
        format!(
            "{DIAGRAM_STYLE_GUIDE}\n\nCreated diagram \"{}\" ({}). Structural check passed. It is saved and available to \
             the user as a diagram artifact (PNG-exportable).",
            file.filename,
            file.path.display()
        )
    } else {
        format!(
            "{DIAGRAM_STYLE_GUIDE}\n\nCreated diagram \"{}\" ({}), but the structural check found issues you should fix \
             before considering it done:\n{}\n\nThe file is saved and visible to the user; revise \
             and regenerate if the issues affect rendering.",
            file.filename,
            file.path.display(),
            report.render()
        )
    };

    ToolOutcome {
        text: note,
        artifact: Some(ArtifactRef {
            path: file.path.display().to_string(),
            filename: file.filename,
        }),
        browse_url: None,
        preview: None,
    }
}

/// Place the diagram sentinel marker at the very start of the file. The
/// preview classifier checks the file's first bytes (`starts_with`), so the
/// marker must precede even the doctype; a leading comment before the doctype
/// still parses in standards mode in modern browsers.
fn prepend_diagram_marker(html: &str) -> String {
    format!("{DIAGRAM_MARKER}\n{}", html.trim_start())
}

/// Lightweight, dependency-free structural check on diagram HTML. This is NOT
/// a render — it catches the failure modes that would make the diagram render
/// broken or empty: missing document skeleton, unclosed tags, <script>/<iframe>
/// (disallowed in the sandboxed preview), and no visible body content. The
/// result is fed back to the model so it can self-correct before the turn ends.
#[derive(Default)]
struct DiagramReport {
    issues: Vec<String>,
}

impl DiagramReport {
    fn is_clean(&self) -> bool {
        self.issues.is_empty()
    }
    fn add(&mut self, msg: impl Into<String>) {
        self.issues.push(msg.into());
    }
    fn render(&self) -> String {
        if self.issues.is_empty() {
            "no issues".to_string()
        } else {
            self.issues
                .iter()
                .enumerate()
                .map(|(i, m)| format!("  {}. {m}", i + 1))
                .collect::<Vec<_>>()
                .join("\n")
        }
    }
}

fn validate_diagram_html(html: &str) -> DiagramReport {
    let mut r = DiagramReport::default();
    let lower = html.to_ascii_lowercase();

    // Must look like an HTML document.
    if !lower.contains("<html") || !lower.contains("</html>") {
        r.add("Missing <html>…</html> document skeleton.");
    }
    if !lower.contains("<body") || !lower.contains("</body>") {
        r.add("Missing <body>…</body>.");
    }

    // The sandboxed preview iframe disables scripts; a <script> would silently
    // do nothing and likely means the diagram relies on JS to render.
    if lower.contains("<script") {
        r.add("Contains a <script> tag — scripts are blocked in the preview iframe; \
              render must be pure HTML/CSS.");
    }
    // iframes inside the diagram are a nesting/security hazard in the sandbox.
    if lower.contains("<iframe") {
        r.add("Contains an <iframe> — not permitted inside the diagram preview.");
    }
    // External resources won't load in the sandboxed srcDoc iframe.
    if lower.contains(" src=\"http") || lower.contains(" src='http") || lower.contains("@import") {
        r.add("References external resources (http(s) src / @import) — the sandboxed \
              preview cannot fetch them; inline all styles.");
    }

    // Balanced-tag check for a small set of structural containers the model is
    // most likely to leave unclosed. We count opening vs closing tags (ignoring
    // self-closing void elements) for div/section/table/svg — a mismatch almost
    // always means a broken layout.
    for tag in ["div", "section", "table", "svg", "ul", "ol"] {
        let open = count_tag(&lower, &format!("<{tag}"));
        let close = count_tag(&lower, &format!("</{tag}>"));
        // Subtract self-closing occurrences like <svg .../> from the open count
        // is unnecessary for these tags in practice; a close-count of 0 with
        // opens > 0 is the real signal.
        if open != close {
            r.add(format!("<{tag}> tags unbalanced: {open} open vs {close} close."));
        }
    }

    // Body should have some visible text/nodes — an empty diagram is almost
    // certainly a mistake. Strip tags crudely and check for non-whitespace.
    let stripped = strip_tags(&lower);
    if stripped.trim().is_empty() {
        r.add("Body has no visible text content — the diagram appears empty.");
    }

    r
}

/// Count non-overlapping occurrences of `needle` in `hay` (case-insensitive
/// already applied by the caller). Used for the balanced-tag check.
fn count_tag(hay: &str, needle: &str) -> usize {
    hay.matches(needle).count()
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_flags_script_and_external_refs() {
        let bad = "<html><body><script>draw()</script><img src=\"https://x/y.png\"></body></html>";
        let r = validate_diagram_html(bad);
        assert!(!r.is_clean());
        let rendered = r.render();
        assert!(rendered.contains("<script>"));
        assert!(rendered.contains("external resources"));
    }

    #[test]
    fn validate_flags_unbalanced_divs() {
        let unbalanced = "<html><body><div><div>oops</div></body></html>"; // one </div> missing
        let r = validate_diagram_html(unbalanced);
        assert!(r.render().contains("<div> tags unbalanced"));
    }

    #[test]
    fn validate_flags_empty_body() {
        let empty = "<html><body></body></html>";
        let r = validate_diagram_html(empty);
        assert!(r.render().contains("no visible text content"));
    }

    #[test]
    fn validate_passes_clean_diagram() {
        let good = "<!doctype html><html><head><style>.n{color:red}</style></head>\
                    <body><div class=\"n\"><section>A → B</section></div></body></html>";
        let r = validate_diagram_html(good);
        assert!(r.is_clean(), "expected clean, got: {}", r.render());
    }

    #[test]
    fn prepend_marker_places_marker_first() {
        // The marker must be the file's first bytes (the preview classifier
        // uses `starts_with`), even when the HTML starts with a doctype.
        let with_doctype = "<!doctype html><html><body>x</body></html>";
        assert!(prepend_diagram_marker(with_doctype).starts_with("<!-- conduit:diagram -->"));
        let no_doctype = "<html><body>x</body></html>";
        assert!(prepend_diagram_marker(no_doctype).starts_with("<!-- conduit:diagram -->"));
    }

    #[test]
    fn generate_diagram_writes_marker_exactly_once() {
        let tmp = tempfile::tempdir().unwrap();
        let args = serde_json::json!({
            "filename": "d.html",
            "html": "<!doctype html><html><body><div>hi</div></body></html>",
        });
        let outcome = generate_diagram(tmp.path(), &args);
        let path = outcome.artifact.expect("artifact ref").path;
        let written = std::fs::read_to_string(path).unwrap();
        assert_eq!(written.matches(DIAGRAM_MARKER).count(), 1, "marker written more than once:\n{written}");
    }

}
