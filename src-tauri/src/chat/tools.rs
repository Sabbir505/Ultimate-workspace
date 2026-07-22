//! Chat tools — the capabilities the model can invoke during a chat turn
//! (function/tool calling), plus their implementations.
//!
//! The registry is provider-agnostic: [`openai_tool_specs`] and
//! [`anthropic_tool_specs`] render the same tools into each wire format, and
//! [`execute_tool`] dispatches a tool call (by name + JSON arguments) to its
//! implementation. New capabilities are added by registering a spec here and a
//! branch in `execute_tool`.

use std::path::Path;

use serde_json::{json, Value};

use super::{artifacts, codeexec, pygen};

/// Names of every tool the model may call. Kept in one place so the specs and
/// the dispatcher can't drift apart.
pub const WEB_SEARCH: &str = "web_search";
pub const GENERATE_FILE: &str = "generate_file";
pub const GENERATE_DOCUMENT: &str = "generate_document";
pub const GENERATE_DIAGRAM: &str = "generate_diagram";
pub const FETCH_URL: &str = "fetch_url";
pub const RUN_CODE: &str = "run_code";
pub const OPEN_URL: &str = "open_url";

/// Which tool capabilities are enabled for a turn. Web search, file generation
/// and URL fetching are considered safe and are always on when tools are
/// enabled; code execution is gated behind an explicit per-chat opt-in.
#[derive(Clone, Copy, Default)]
pub struct ToolCaps {
    pub code_exec: bool,
}

/// A file produced by a tool, surfaced to the UI as a downloadable artifact.
pub struct ArtifactRef {
    pub path: String,
    pub filename: String,
}

/// Result of a tool call: `text` is fed back to the model; `artifact` (if any)
/// is surfaced to the UI; `browse_url` (if any) asks the UI to open that URL in
/// the built-in browser pane.
pub struct ToolOutcome {
    pub text: String,
    pub artifact: Option<ArtifactRef>,
    pub browse_url: Option<String>,
}

impl ToolOutcome {
    fn text(t: impl Into<String>) -> Self {
        Self {
            text: t.into(),
            artifact: None,
            browse_url: None,
        }
    }
}

const WEB_SEARCH_DESC: &str = "Search the public web for up-to-date information. \
    Returns a list of result titles, URLs and snippets. Use this whenever the \
    answer may depend on current events or facts you are unsure about.";

const GENERATE_FILE_DESC: &str = "Generate a simple downloadable text-based \
    file/artifact and save it to disk. Best for plain formats: txt, md, csv, \
    json, html. For a professionally formatted docx/pptx/xlsx/pdf, prefer \
    generate_document instead. For pptx here, separate slides with a line \
    containing only '---'; the first line of each slide is its title and \
    remaining lines are bullets. For xlsx/csv, provide comma-separated rows \
    (one row per line).";

const GENERATE_DOCUMENT_DESC: &str = "Create a REAL, professionally designed \
    document by writing Python that builds it, then saves it to the path in the \
    CONDUIT_OUTPUT environment variable (the requested filename inside the \
    working directory). Supports docx, pptx, xlsx and pdf. The output must look \
    polished — like something ChatGPT/Claude would produce — NOT a plain text \
    dump: a cover/title, themed colours, real typography, headings, tables, and \
    for decks multiple well-laid-out slides with a title slide and section \
    dividers.\n\n\
    STRONGLY PREFER the pre-installed `conduit_docgen` helper — it ships a \
    consistent, professional theme for docx, pptx AND pdf with almost no code:\n\
      import conduit_docgen as cd\n\
      doc = cd.Doc(title='Quarterly Report', subtitle='FY2025 Q2', theme='blue', author='Acme')\n\
      doc.heading('Overview'); doc.paragraph('...'); doc.bullets(['a','b']); doc.numbered(['1','2'])\n\
      doc.table(['Metric','Value'], [['Revenue','$1.2M']]); doc.callout('Key point'); doc.save()\n\
      deck = cd.Deck(title='Product Launch', subtitle='2025', theme='blue', footer='Acme Inc')\n\
      deck.section('Introduction', number=1); deck.bullets('Why now', ['ready','mature'], eyebrow='Context')\n\
      deck.two_column('Compare','A',['fast'],'B',['robust']); deck.table_slide('Numbers',['Q','Rev'],[['Q1','1.0']])\n\
      deck.closing('Thank you','q@acme.com'); deck.save()\n\
      pdf = cd.Pdf(title='Research Brief', subtitle='...', theme='plum', author='Acme Labs')\n\
      pdf.heading('Summary'); pdf.paragraph('...'); pdf.bullets(['a','b'])\n\
      pdf.table(['Model','Latency'], [['A','12ms']]); pdf.callout('Bottom line'); pdf.save()\n\
    Themes: blue, slate, emerald, plum, amber. cd.Pdf handles pdf via reportlab; \
    prefer it over hand-rolled reportlab. You can still access doc.document / \
    deck.prs for raw python-docx/python-pptx tweaks. For xlsx use openpyxl. \
    Build enough real content to be genuinely useful (several sections or 6+ \
    slides for a deck). Import only from the standard library, conduit_docgen, \
    python-docx, python-pptx, openpyxl and reportlab. Do not print secrets or \
    perform network side effects.";

const GENERATE_DIAGRAM_DESC: &str = "Create a hand-styled, fully-laid-out \
    HTML/CSS diagram as a self-contained .html file. Use this when a diagram \
    needs deliberate visual hierarchy that Mermaid's auto-layout can't express \
    — nested groupings/containers, a 2-D grid of sub-nodes, mixed box sizes, a \
    bold-label-plus-dim-description two-line node, solid primary-flow arrows \
    with a dashed feedback line looping back, and consistent color-per-category. \
    Emit ONE complete HTML document in the `html` argument: a title placed \
    ABOVE the flow (not inside it), a styled <body> with inline <style> (no \
    external resources, no scripts), semantic node boxes, connector arrows \
    (CSS/SVG), and a legend if colors carry meaning. The diagram is rendered \
    in the artifact panel and can be exported to PNG. Do NOT use this for \
    simple flowcharts/sequences that Mermaid handles well — those go in a \
    ```mermaid block in your text response instead.";

const FETCH_URL_DESC: &str = "Fetch a specific web page by URL and return its \
    readable text content (HTML stripped). Use to read an article or page the \
    user linked, or a result returned by web_search.";

const RUN_CODE_DESC: &str = "Execute a short snippet of code and return its \
    output. Supports python, javascript (node) and bash. Runs locally with a \
    time limit in a temporary directory. Use for calculations, data wrangling \
    or quick scripts.";

const OPEN_URL_DESC: &str = "Open a web page in the app's built-in browser so \
    the user can see it, and return its readable text to you. Use when the user \
    asks to open/show/visit a site, or when it helps to display a page visually \
    alongside your answer.";

/// OpenAI `tools` array (`{type:"function", function:{...}}` entries).
pub fn openai_tool_specs(caps: ToolCaps) -> Vec<Value> {
    let mut specs = vec![
        openai_fn(WEB_SEARCH, WEB_SEARCH_DESC, web_search_parameters()),
        openai_fn(GENERATE_FILE, GENERATE_FILE_DESC, generate_file_parameters()),
        openai_fn(
            GENERATE_DOCUMENT,
            GENERATE_DOCUMENT_DESC,
            generate_document_parameters(),
        ),
        openai_fn(GENERATE_DIAGRAM, GENERATE_DIAGRAM_DESC, generate_diagram_parameters()),
        openai_fn(FETCH_URL, FETCH_URL_DESC, fetch_url_parameters()),
        openai_fn(OPEN_URL, OPEN_URL_DESC, fetch_url_parameters()),
    ];
    if caps.code_exec {
        specs.push(openai_fn(RUN_CODE, RUN_CODE_DESC, run_code_parameters()));
    }
    specs
}

fn openai_fn(name: &str, description: &str, parameters: Value) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        }
    })
}

/// Anthropic `tools` array (`{name, description, input_schema}` entries).
pub fn anthropic_tool_specs(caps: ToolCaps) -> Vec<Value> {
    let mut specs = vec![
        anthropic_fn(WEB_SEARCH, WEB_SEARCH_DESC, web_search_parameters()),
        anthropic_fn(GENERATE_FILE, GENERATE_FILE_DESC, generate_file_parameters()),
        anthropic_fn(
            GENERATE_DOCUMENT,
            GENERATE_DOCUMENT_DESC,
            generate_document_parameters(),
        ),
        anthropic_fn(GENERATE_DIAGRAM, GENERATE_DIAGRAM_DESC, generate_diagram_parameters()),
        anthropic_fn(FETCH_URL, FETCH_URL_DESC, fetch_url_parameters()),
        anthropic_fn(OPEN_URL, OPEN_URL_DESC, fetch_url_parameters()),
    ];
    if caps.code_exec {
        specs.push(anthropic_fn(RUN_CODE, RUN_CODE_DESC, run_code_parameters()));
    }
    specs
}

fn anthropic_fn(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "input_schema": input_schema,
    })
}

fn web_search_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query.",
            }
        },
        "required": ["query"],
    })
}

fn generate_file_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "format": {
                "type": "string",
                "enum": ["pdf", "docx", "pptx", "xlsx", "csv", "md", "txt", "html", "json"],
                "description": "The file format to generate.",
            },
            "filename": {
                "type": "string",
                "description": "Base file name (extension optional).",
            },
            "title": {
                "type": "string",
                "description": "Optional document/deck title.",
            },
            "content": {
                "type": "string",
                "description": "The textual content of the file.",
            }
        },
        "required": ["format", "filename", "content"],
    })
}

fn generate_document_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "format": {
                "type": "string",
                "enum": ["docx", "pptx", "xlsx", "pdf"],
                "description": "The document format to generate.",
            },
            "filename": {
                "type": "string",
                "description": "Base file name (extension optional).",
            },
            "code": {
                "type": "string",
                "description": "Complete Python source that builds the document \
                    and saves it to the CONDUIT_OUTPUT path. For docx/pptx \
                    prefer `import conduit_docgen as cd` (pre-installed styled \
                    toolkit); otherwise use python-docx / python-pptx / openpyxl \
                    / reportlab directly. Produce a polished, themed result with \
                    real content — not a plain text dump.",
            }
        },
        "required": ["format", "filename", "code"],
    })
}

fn generate_diagram_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "filename": {
                "type": "string",
                "description": "Base file name (extension optional; .html is used).",
            },
            "title": {
                "type": "string",
                "description": "Diagram title, shown above the flow.",
            },
            "html": {
                "type": "string",
                "description": "Complete self-contained HTML document for the \
                    diagram (inline <style>, no external resources, no scripts). \
                    This is written verbatim to the .html file.",
            }
        },
        "required": ["filename", "html"],
    })
}

fn fetch_url_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The absolute http(s) URL to fetch.",
            }
        },
        "required": ["url"],
    })
}

fn run_code_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "language": {
                "type": "string",
                "enum": ["python", "javascript", "bash"],
                "description": "The language of the snippet.",
            },
            "code": {
                "type": "string",
                "description": "The source code to execute.",
            }
        },
        "required": ["language", "code"],
    })
}

/// Dispatch a tool call to its implementation. `args` is the JSON object of
/// arguments the model produced. Returns the tool result as a string that is
/// fed back to the model as a `tool` / `tool_result` message.
pub async fn execute_tool(
    client: &reqwest::Client,
    artifacts_dir: &Path,
    caps: ToolCaps,
    name: &str,
    args: &Value,
) -> ToolOutcome {
    match name {
        WEB_SEARCH => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            if query.trim().is_empty() {
                return ToolOutcome::text("Error: web_search requires a non-empty \"query\".");
            }
            match web_search(client, query).await {
                Ok(results) => ToolOutcome::text(results),
                Err(e) => ToolOutcome::text(format!("web_search failed: {e}")),
            }
        }
        GENERATE_FILE => generate_file(artifacts_dir, args),
        GENERATE_DOCUMENT => generate_document(artifacts_dir, args).await,
        GENERATE_DIAGRAM => generate_diagram(artifacts_dir, args),
        FETCH_URL => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
            match fetch_url(client, url).await {
                Ok(text) => ToolOutcome::text(text),
                Err(e) => ToolOutcome::text(format!("fetch_url failed: {e}")),
            }
        }
        OPEN_URL => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("").trim();
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return ToolOutcome::text("Error: open_url requires an http(s) URL.");
            }
            let normalized = url.to_string();
            match fetch_url(client, url).await {
                Ok(text) => ToolOutcome {
                    text: format!("Opened {normalized} in the built-in browser.\n\n{text}"),
                    artifact: None,
                    browse_url: Some(normalized),
                },
                // Even if reading fails, still show the page to the user.
                Err(e) => ToolOutcome {
                    text: format!("Opened {normalized} in the built-in browser (could not extract text: {e})."),
                    artifact: None,
                    browse_url: Some(normalized),
                },
            }
        }
        RUN_CODE => {
            if !caps.code_exec {
                return ToolOutcome::text(
                    "Error: code execution is disabled. The user must enable it for this chat.",
                );
            }
            let language = args.get("language").and_then(|v| v.as_str()).unwrap_or("");
            let code = args.get("code").and_then(|v| v.as_str()).unwrap_or("");
            if code.trim().is_empty() {
                return ToolOutcome::text("Error: run_code requires non-empty \"code\".");
            }
            ToolOutcome::text(codeexec::run_code(language, code).await)
        }
        other => ToolOutcome::text(format!("Error: unknown tool \"{other}\".")),
    }
}

/// Fetch a URL and return its readable text (HTML stripped, truncated).
async fn fetch_url(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("url must start with http:// or https://".to_string());
    }
    let resp = client
        .get(url)
        .header("User-Agent", "Conduit/0.1 (chat fetch_url)")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let title = extract_title(&body);
    let text = html_to_text(&body);
    const MAX: usize = 12_000;
    let text = if text.len() > MAX {
        let mut cut = MAX;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}\n… (content truncated)", &text[..cut])
    } else {
        text
    };
    Ok(format!("Title: {title}\nURL: {url}\n\n{text}"))
}

fn extract_title(html: &str) -> String {
    // ASCII lowercase preserves byte length, so offsets found in `lower` are
    // valid indices into `html` (Unicode `to_lowercase` can change length).
    let lower = html.to_ascii_lowercase();
    if let Some(start) = lower.find("<title") {
        if let Some(gt) = lower[start..].find('>') {
            let from = start + gt + 1;
            if let Some(end) = lower[from..].find("</title>") {
                return strip_html(&html[from..from + end]);
            }
        }
    }
    "(no title)".to_string()
}

/// Strip scripts/styles/tags from a full HTML document and collapse whitespace.
fn html_to_text(html: &str) -> String {
    let without_blocks = remove_blocks(html, &["script", "style", "noscript", "head", "svg"]);
    let stripped = strip_html(&without_blocks);
    // Collapse runs of whitespace / blank lines.
    let mut out = String::with_capacity(stripped.len());
    let mut blank_run = 0;
    for line in stripped.lines() {
        let t = line.trim();
        if t.is_empty() {
            blank_run += 1;
            if blank_run <= 1 {
                out.push('\n');
            }
        } else {
            blank_run = 0;
            out.push_str(t);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

/// Remove `<tag>…</tag>` regions (case-insensitive) entirely. The opening tag
/// is matched on a name boundary so `<head>` does not also match `<header>`.
fn remove_blocks(html: &str, tags: &[&str]) -> String {
    let mut s = html.to_string();
    for tag in tags {
        loop {
            // ASCII lowercase preserves byte length so offsets stay valid in `s`.
            let lower = s.to_ascii_lowercase();
            let open = format!("<{tag}");
            let close = format!("</{tag}>");

            // Find `<tag` where the following char ends the tag name (space,
            // `>`, `/`, or the tag is self-terminated), skipping e.g. `<header`.
            let mut search_from = 0;
            let start = loop {
                match lower[search_from..].find(&open) {
                    None => break None,
                    Some(rel) => {
                        let idx = search_from + rel;
                        let after = &lower[idx + open.len()..];
                        let boundary = after
                            .chars()
                            .next()
                            .map(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '>' | '/'))
                            .unwrap_or(true);
                        if boundary {
                            break Some(idx);
                        }
                        search_from = idx + open.len();
                    }
                }
            };
            let Some(start) = start else { break };
            let Some(rel_end) = lower[start..].find(&close) else {
                s.truncate(start);
                break;
            };
            let end = start + rel_end + close.len();
            s.replace_range(start..end, " ");
        }
    }
    s
}

fn generate_file(artifacts_dir: &Path, args: &Value) -> ToolOutcome {
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
        },
        Err(e) => ToolOutcome::text(format!("generate_file failed: {e}")),
    }
}

/// Build a rich document by running the model's Python (python-docx etc.).
async fn generate_document(artifacts_dir: &Path, args: &Value) -> ToolOutcome {
    let format = args
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let filename = args.get("filename").and_then(|v| v.as_str()).unwrap_or("");
    let code = args.get("code").and_then(|v| v.as_str()).unwrap_or("");

    if !pygen::is_supported(&format) {
        return ToolOutcome::text(format!(
            "Error: generate_document supports docx, pptx, xlsx and pdf (got \"{format}\"). \
             Use generate_file for plain text formats."
        ));
    }
    if filename.trim().is_empty() {
        return ToolOutcome::text("Error: generate_document requires a \"filename\".");
    }

    match pygen::generate(artifacts_dir, &format, filename, code).await {
        Ok(file) => ToolOutcome {
            text: format!(
                "Created document \"{}\" ({}). It has been saved and is available to the user.",
                file.filename,
                file.path.display()
            ),
            artifact: Some(ArtifactRef {
                path: file.path.display().to_string(),
                filename: file.filename,
            }),
            browse_url: None,
        },
        Err(e) => ToolOutcome::text(format!(
            "generate_document failed: {e}\n\nIf the document library is unavailable, fall back \
             to generate_file with well-structured content."
        )),
    }
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
fn generate_diagram(artifacts_dir: &Path, args: &Value) -> ToolOutcome {
    let filename = args.get("filename").and_then(|v| v.as_str()).unwrap_or("");
    let html = args.get("html").and_then(|v| v.as_str()).unwrap_or("");

    if filename.trim().is_empty() {
        return ToolOutcome::text("Error: generate_diagram requires a \"filename\".");
    }
    if html.trim().is_empty() {
        return ToolOutcome::text("Error: generate_diagram requires non-empty \"html\".");
    }

    // Prepend the sentinel marker (after the doctype, if present, so the file
    // stays a valid HTML document). Falls back to prefixing the whole thing.
    let body = prepend_diagram_marker(html);
    let full = format!("{DIAGRAM_MARKER}\n{body}");

    // Reuse the artifacts writer with the `html` format so we get the same
    // filename-sanitization, extension-handling, and dir-creation behavior.
    let file = match artifacts::generate(artifacts_dir, "html", filename, None, &full) {
        Ok(f) => f,
        Err(e) => return ToolOutcome::text(format!("generate_diagram failed: {e}")),
    };

    let report = validate_diagram_html(html);
    let note = if report.is_clean() {
        format!(
            "Created diagram \"{}\" ({}). Structural check passed. It is saved and available to \
             the user as a diagram artifact (PNG-exportable).",
            file.filename,
            file.path.display()
        )
    } else {
        format!(
            "Created diagram \"{}\" ({}), but the structural check found issues you should fix \
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
    }
}

/// Place the diagram sentinel marker right after the doctype declaration so
/// the document remains valid HTML while still carrying the marker at the top.
fn prepend_diagram_marker(html: &str) -> String {
    let trimmed = html.trim_start();
    if let Some(rest) = trimmed
        .strip_prefix("<!doctype html>")
        .or_else(|| trimmed.strip_prefix("<!DOCTYPE html>"))
    {
        format!("<!doctype html>\n{DIAGRAM_MARKER}\n{rest}")
    } else {
        format!("{DIAGRAM_MARKER}\n{trimmed}")
    }
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

/// A single search hit.
struct SearchHit {
    title: String,
    url: String,
    snippet: String,
}

/// Free, no-API-key web search. Combines two reliable keyless sources:
///   * DuckDuckGo Instant Answer API — topic abstract + related links.
///   * Wikipedia search API — encyclopedic article snippets.
/// Results are merged and rendered as a plain-text list for the model.
async fn web_search(client: &reqwest::Client, query: &str) -> Result<String, String> {
    let mut hits: Vec<SearchHit> = Vec::new();

    if let Ok(mut ddg) = duckduckgo_instant(client, query).await {
        hits.append(&mut ddg);
    }
    if let Ok(mut wiki) = wikipedia_search(client, query).await {
        hits.append(&mut wiki);
    }

    // De-duplicate by URL, preserving order.
    let mut seen = std::collections::HashSet::new();
    hits.retain(|h| !h.url.is_empty() && seen.insert(h.url.clone()));

    if hits.is_empty() {
        return Ok(format!(
            "No results found for \"{query}\". Try rephrasing the query."
        ));
    }

    let mut out = format!("Search results for \"{query}\":\n\n");
    for (i, h) in hits.iter().take(8).enumerate() {
        out.push_str(&format!("{}. {} — {}\n", i + 1, h.title, h.url));
        if !h.snippet.is_empty() {
            out.push_str(&format!("   {}\n", h.snippet));
        }
    }
    Ok(out)
}

async fn duckduckgo_instant(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<SearchHit>, String> {
    let url = "https://api.duckduckgo.com/";
    let resp = client
        .get(url)
        .query(&[
            ("q", query),
            ("format", "json"),
            ("no_html", "1"),
            ("t", "conduit"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parse_duckduckgo(&json))
}

/// Pull the abstract and related topics out of a DuckDuckGo IA response.
fn parse_duckduckgo(json: &Value) -> Vec<SearchHit> {
    let mut hits = Vec::new();

    let abstract_text = json.get("AbstractText").and_then(|v| v.as_str()).unwrap_or("");
    let abstract_url = json.get("AbstractURL").and_then(|v| v.as_str()).unwrap_or("");
    if !abstract_text.is_empty() && !abstract_url.is_empty() {
        let heading = json.get("Heading").and_then(|v| v.as_str()).unwrap_or("Result");
        hits.push(SearchHit {
            title: heading.to_string(),
            url: abstract_url.to_string(),
            snippet: abstract_text.to_string(),
        });
    }

    if let Some(topics) = json.get("RelatedTopics").and_then(|v| v.as_array()) {
        for t in topics {
            // Related topics are either a hit ({Text, FirstURL}) or a group
            // ({Name, Topics:[...]}). Flatten one level of groups.
            if let Some(hit) = related_topic_hit(t) {
                hits.push(hit);
            } else if let Some(sub) = t.get("Topics").and_then(|v| v.as_array()) {
                for st in sub {
                    if let Some(hit) = related_topic_hit(st) {
                        hits.push(hit);
                    }
                }
            }
        }
    }

    hits
}

fn related_topic_hit(t: &Value) -> Option<SearchHit> {
    let text = t.get("Text").and_then(|v| v.as_str())?;
    let url = t.get("FirstURL").and_then(|v| v.as_str())?;
    if text.is_empty() || url.is_empty() {
        return None;
    }
    // Use the leading phrase (before the first " - ") as the title.
    let title = text.split(" - ").next().unwrap_or(text).to_string();
    Some(SearchHit {
        title,
        url: url.to_string(),
        snippet: text.to_string(),
    })
}

async fn wikipedia_search(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<SearchHit>, String> {
    let url = "https://en.wikipedia.org/w/api.php";
    let resp = client
        .get(url)
        .header("User-Agent", "Conduit/0.1 (chat web_search)")
        .query(&[
            ("action", "query"),
            ("list", "search"),
            ("srsearch", query),
            ("format", "json"),
            ("srlimit", "4"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parse_wikipedia(&json))
}

/// Turn Wikipedia search results into hits (stripping the HTML `<span>`
/// highlight markup Wikipedia embeds in snippets).
fn parse_wikipedia(json: &Value) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    if let Some(results) = json
        .get("query")
        .and_then(|q| q.get("search"))
        .and_then(|s| s.as_array())
    {
        for r in results {
            let title = match r.get("title").and_then(|v| v.as_str()) {
                Some(t) => t,
                None => continue,
            };
            let snippet_raw = r.get("snippet").and_then(|v| v.as_str()).unwrap_or("");
            let snippet = strip_html(snippet_raw);
            let url = format!(
                "https://en.wikipedia.org/wiki/{}",
                title.replace(' ', "_")
            );
            hits.push(SearchHit {
                title: title.to_string(),
                url,
                snippet,
            });
        }
    }
    hits
}

/// Minimal HTML tag stripper for Wikipedia snippet markup. Also decodes the
/// handful of entities Wikipedia emits.
fn strip_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for c in input.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&quot;", "\"")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#39;", "'")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn openai_names(caps: ToolCaps) -> Vec<String> {
        openai_tool_specs(caps)
            .iter()
            .map(|s| s["function"]["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn openai_spec_lists_safe_tools() {
        let names = openai_names(ToolCaps::default());
        assert!(names.contains(&WEB_SEARCH.to_string()));
        assert!(names.contains(&GENERATE_FILE.to_string()));
        assert!(names.contains(&FETCH_URL.to_string()));
        assert!(!names.contains(&RUN_CODE.to_string()));
        let specs = openai_tool_specs(ToolCaps::default());
        assert_eq!(specs[0]["type"], "function");
        assert!(specs[0]["function"]["parameters"]["properties"]["query"].is_object());
    }

    #[test]
    fn generate_diagram_listed_as_safe_tool() {
        assert!(openai_names(ToolCaps::default()).contains(&GENERATE_DIAGRAM.to_string()));
        let a = anthropic_tool_specs(ToolCaps::default());
        assert!(a.iter().any(|s| s["name"] == GENERATE_DIAGRAM));
        // The diagram tool must expose filename + html args.
        let binding = openai_tool_specs(ToolCaps::default());
        let spec = &binding
            .iter()
            .find(|s| s["function"]["name"] == GENERATE_DIAGRAM)
            .unwrap()["function"]["parameters"];
        assert!(spec["properties"]["html"].is_object());
        assert!(spec["required"].as_array().unwrap().contains(&json!("html")));
    }

    #[test]
    fn generate_diagram_writes_marker_and_surfaces_artifact() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir();
        let html = "<!doctype html><html><body><div>A→B</div></body></html>";
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            ToolCaps::default(),
            GENERATE_DIAGRAM,
            &json!({ "filename": "diag_test", "html": html }),
        ));
        assert!(out.artifact.is_some(), "should surface an artifact");
        let art = out.artifact.unwrap();
        assert!(art.filename.ends_with(".html"));
        let on_disk = std::fs::read_to_string(&art.path).unwrap();
        assert!(on_disk.starts_with(DIAGRAM_MARKER), "file must start with the diagram marker");
        // The structural check should pass for this clean input.
        assert!(out.text.contains("Structural check passed"), "text was: {}", out.text);
        let _ = std::fs::remove_file(&art.path);
    }

    #[test]
    fn generate_diagram_rejects_empty_html() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir();
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            ToolCaps::default(),
            GENERATE_DIAGRAM,
            &json!({ "filename": "x", "html": "" }),
        ));
        assert!(out.artifact.is_none());
        assert!(out.text.contains("requires non-empty"));
    }

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
    fn prepend_marker_after_doctype() {
        let with_doctype = "<!doctype html><html><body>x</body></html>";
        assert!(prepend_diagram_marker(with_doctype).contains("<!doctype html>\n<!-- conduit:diagram -->"));
        let no_doctype = "<html><body>x</body></html>";
        assert!(prepend_diagram_marker(no_doctype).starts_with("<!-- conduit:diagram -->"));
    }

    #[test]
    fn run_code_gated_behind_capability() {
        assert!(!openai_names(ToolCaps::default()).contains(&RUN_CODE.to_string()));
        assert!(openai_names(ToolCaps { code_exec: true }).contains(&RUN_CODE.to_string()));
    }

    #[test]
    fn open_url_listed_as_safe_tool() {
        assert!(openai_names(ToolCaps::default()).contains(&OPEN_URL.to_string()));
    }

    #[test]
    fn open_url_rejects_non_http() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir();
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            ToolCaps::default(),
            OPEN_URL,
            &json!({ "url": "ftp://example.com" }),
        ));
        assert!(out.browse_url.is_none());
        assert!(out.text.contains("http(s)"));
    }

    #[test]
    fn anthropic_spec_lists_safe_tools() {
        let specs = anthropic_tool_specs(ToolCaps::default());
        let names: Vec<&str> = specs.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert!(names.contains(&WEB_SEARCH));
        assert!(names.contains(&FETCH_URL));
        assert!(!names.contains(&RUN_CODE));
        assert!(specs[0]["input_schema"]["properties"]["query"].is_object());
    }

    #[test]
    fn html_to_text_drops_scripts_and_tags() {
        let html = "<html><head><title>Hi</title><style>x{}</style></head>\
            <body><script>bad()</script><p>Hello <b>world</b></p></body></html>";
        assert_eq!(extract_title(html), "Hi");
        let text = html_to_text(html);
        assert!(text.contains("Hello"));
        assert!(text.contains("world"));
        assert!(!text.contains("bad()"));
        assert!(!text.to_lowercase().contains("<p>"));
    }

    #[test]
    fn code_exec_rejected_when_capability_off() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir();
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            ToolCaps::default(),
            RUN_CODE,
            &json!({ "language": "python", "code": "print(1)" }),
        ));
        assert!(out.text.contains("code execution is disabled"));
    }

    #[test]
    fn parse_duckduckgo_extracts_abstract_and_topics() {
        let json = json!({
            "Heading": "Ada Lovelace",
            "AbstractText": "English mathematician and writer.",
            "AbstractURL": "https://en.wikipedia.org/wiki/Ada_Lovelace",
            "RelatedTopics": [
                { "Text": "Analytical Engine - a proposed machine", "FirstURL": "https://duckduckgo.com/Analytical_Engine" },
                { "Name": "Group", "Topics": [
                    { "Text": "Ada (language) - named after Lovelace", "FirstURL": "https://duckduckgo.com/Ada" }
                ]}
            ]
        });
        let hits = parse_duckduckgo(&json);
        assert_eq!(hits[0].title, "Ada Lovelace");
        assert_eq!(hits[0].url, "https://en.wikipedia.org/wiki/Ada_Lovelace");
        assert_eq!(hits[1].title, "Analytical Engine");
        assert_eq!(hits[2].title, "Ada (language)");
    }

    #[test]
    fn parse_wikipedia_strips_html_and_builds_url() {
        let json = json!({
            "query": { "search": [
                { "title": "Rust (programming language)",
                  "snippet": "<span class=\"searchmatch\">Rust</span> is a language" }
            ]}
        });
        let hits = parse_wikipedia(&json);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Rust (programming language)");
        assert_eq!(hits[0].snippet, "Rust is a language");
        assert_eq!(
            hits[0].url,
            "https://en.wikipedia.org/wiki/Rust_(programming_language)"
        );
    }

    #[test]
    fn strip_html_decodes_entities() {
        assert_eq!(strip_html("a &amp; b &quot;c&quot;"), "a & b \"c\"");
        assert_eq!(strip_html("<b>bold</b> text"), "bold text");
    }

    #[test]
    #[ignore = "hits the live network"]
    fn fetch_url_live_returns_text() {
        let client = reqwest::Client::new();
        let out = tauri::async_runtime::block_on(fetch_url(
            &client,
            "https://example.com",
        ))
        .unwrap();
        println!("{out}");
        assert!(out.contains("Example Domain"));
        assert!(!out.to_lowercase().contains("<html"));
    }

    #[test]
    #[ignore = "hits the live network; inspect readable-text quality"]
    fn fetch_url_live_wikipedia_quality() {
        let client = reqwest::Client::new();
        let out = tauri::async_runtime::block_on(fetch_url(
            &client,
            "https://en.wikipedia.org/wiki/Demographics_of_France",
        ))
        .unwrap();
        println!("===LEN {}===", out.len());
        println!("{}", &out[..out.len().min(1500)]);
    }

    #[test]
    #[ignore = "hits the live network"]
    fn web_search_live_returns_results() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir();
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            ToolCaps::default(),
            WEB_SEARCH,
            &json!({ "query": "rust programming language" }),
        ));
        println!("{}", out.text);
        assert!(out.text.contains("Search results"));
        assert!(out.text.contains("http"));
    }

    #[test]
    fn execute_unknown_tool_reports_error() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir();
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            ToolCaps::default(),
            "does_not_exist",
            &json!({}),
        ));
        assert!(out.text.contains("unknown tool"));
    }
}
