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

use super::codeexec;

mod search;
use search::{fetch_url, web_search};
/// Re-exported so `download_task` (chat/tasks.rs) can reuse the SSRF guard
/// (host_blocked / is_blocked_ip) instead of duplicating it.
pub(crate) use search::{host_blocked, is_blocked_ip};

mod generate;
use generate::{generate_document, generate_diagram, generate_file};
/// Re-exported so `commands.rs` can detect diagram artifacts via
/// `crate::chat::tools::DIAGRAM_MARKER`.
pub use generate::DIAGRAM_MARKER;

mod fs;
use fs::{
    fs_copy_file, fs_delete_file, fs_edit_file, fs_list_directory, fs_move_file, fs_read_file,
    fs_search_files, fs_write_file,
};
mod search_content;
use search_content::fs_search_content;

mod specs;
/// Re-exported so `streaming.rs` can render the tool registry via
/// `tools::openai_tool_specs` / `tools::anthropic_tool_specs`.
pub use specs::{anthropic_tool_specs, openai_tool_specs};

/// Names of every tool the model may call. Kept in one place so the specs and
/// the dispatcher can't drift apart.
pub const WEB_SEARCH: &str = "web_search";
pub const GENERATE_FILE: &str = "generate_file";
pub const GENERATE_DOCUMENT: &str = "generate_document";
pub const GENERATE_DIAGRAM: &str = "generate_diagram";
pub const FETCH_URL: &str = "fetch_url";
pub const RUN_CODE: &str = "run_code";
pub const OPEN_URL: &str = "open_url";
pub const GET_SKILL: &str = "get_skill";
pub const LIST_SKILLS: &str = "list_skills";
pub const BROWSER_READ: &str = "browser_read";

pub const BROWSER_CLICK: &str = "browser_click";
pub const BROWSER_TYPE: &str = "browser_type";
pub const BROWSER_SCROLL: &str = "browser_scroll";
pub const BROWSER_SCREENSHOT: &str = "browser_screenshot";

// ---- System tools (background downloads + native shell) ----
//
// These are the "do it for me" capabilities: `download_file` streams a URL
// to an absolute local path (e.g. model weights from Hugging Face) and
// `run_shell` executes a native shell command on the host. Both run as
// background tasks so a multi-GB download or a long CLI run never blocks the
// conversation turn; the model tracks them with `get_task_status` /
// `download_progress` and aborts them with `cancel_task`. See chat/tasks.rs
// for the task engine.

/// Stream a file from a URL to an absolute local path as a background task.
/// Returns a task id immediately; track with `download_progress`. Mutating
/// (writes to disk) — gated by the permission mode like a filesystem write.
pub const DOWNLOAD_FILE: &str = "download_file";
/// Report a background download task's live progress. Read-only, auto-runs.
pub const DOWNLOAD_PROGRESS: &str = "download_progress";
/// Run a native shell command on the host (cmd.exe / sh), streaming output
/// as a background task. Unsandboxed by design — ALWAYS requires approval.
pub const RUN_SHELL: &str = "run_shell";
/// Spawn a focused subagent that does ONE thing with its own model turn and
/// reports back. Streams its output to the Agents panel + git sidebar.
pub const TASK: &str = "Task";
/// Report any background task's status (downloads and shells). Read-only.
pub const GET_TASK_STATUS: &str = "get_task_status";
/// Cancel a background task (aborts the download, keeping its .part for
/// resume, or kills the shell process). Applies only to tasks the model
/// started in this session.
pub const CANCEL_TASK: &str = "cancel_task";

// ---- Research source ledger ----
//
// Tools the model calls during a research turn to record what it learns. They
// persist notes per chat session (see db/source_ledger.rs) so Synthesis can
// read back a structured, attributed ledger instead of relying on
// conversation memory. They are dispatched in chat/mod.rs (run_ledger_tool),
// NOT via execute_tool, because they need DB access.

/// Record one fact extracted from a source. Call once per distinct fact worth
/// keeping (a single page read may produce several notes, or none).
pub const ADD_SOURCE_NOTE: &str = "add_source_note";
/// Re-read the accumulated source notes for this chat session as JSON.
pub const GET_SOURCE_LEDGER: &str = "get_source_ledger";
/// Clear the source ledger for this chat session — call at the start of every
/// new research task so a fresh question begins from a clean ledger.
pub const RESET_SOURCE_LEDGER: &str = "reset_source_ledger";

// ---- Filesystem tools (the "filesystem tool-use" layer) ----
//
// Read-only tools auto-run in every permission mode; mutating tools are
// governed by the central `check_permission` gate (see `permission.rs`).
// Under `read_only` mode the mutating tools here are filtered out of the
// tool schema entirely — see `fs_mutating_tool_names`.

/// List one level of a directory. Read-only, auto-runs in every mode.
pub const LIST_DIRECTORY: &str = "list_directory";
/// Read a file's text contents (length-capped). Read-only.
pub const READ_FILE: &str = "read_file";
/// Search for files under a directory by name/glob substring. Read-only.
pub const SEARCH_FILES: &str = "search_files";
/// Search for a substring or regex inside file CONTENTS under a directory
/// (read-only). The "find where X is defined / where X is used" tool —
/// prefer this over `search_files` whenever the user means content, not
/// filenames. Returns `path:line:col: matched-line` rows.
pub const SEARCH_CONTENT: &str = "search_content";
/// Create or overwrite a file. Mutating — gated by the permission mode.
pub const WRITE_FILE: &str = "write_file";
/// Edit part of a file (find/replace or append). Mutating.
pub const EDIT_FILE: &str = "edit_file";
/// Delete a file or empty directory. Mutating — ALWAYS gated, every mode.
pub const DELETE_FILE: &str = "delete_file";
/// Move/rename a file. Mutating.
pub const MOVE_FILE: &str = "move_file";
/// Copy a file. Mutating.
pub const COPY_FILE: &str = "copy_file";

/// Which tool capabilities are enabled for a turn. Web search, file generation
/// and URL fetching are considered safe and are always on when tools are
/// enabled; code execution is gated behind an explicit per-chat opt-in.
///
/// `fs_roots` is the per-session set of already-granted directory roots the
/// model may read/write within (the granted-roots model from the filesystem
/// task). Empty by default — the model can still call read-only FS tools on
/// any path the OS permits, but mutating tools within auto-run modes only
/// auto-run when the target lies in a granted root.
#[derive(Clone)]
pub struct ToolCaps {
    pub code_exec: bool,
    /// Per-session granted roots for the auto-run permission modes.
    pub fs_roots: Vec<String>,
    /// Whether web-search tools are exposed to the model. Local models
    /// (LocalGguf) don't have this capability — they ride the same
    /// OpenAI tool loop but get a stripped schema.
    pub web_search: bool,
    /// True for providers whose code execution must stay inside the bundled
    /// local sandbox (LocalGguf). The tool loop consults this so a local
    /// model's `run_code` calls are constrained to the sandbox rather than
    /// any system interpreter path.
    ///
    /// Currently plumbed end-to-end but not yet branched on: code execution
    /// already routes through the bundled sandboxed Python unconditionally
    /// (`chat::python_runtime`), so there is no non-sandbox path to gate
    /// against yet. The field is part of the capability contract so a future
    /// host-execution path can be constrained for local models without
    /// restructuring how capabilities are passed down.
    #[allow(dead_code)]
    pub requires_local_sandbox: bool,
    /// Connectors attached to THIS turn only (per-conversation opt-in). Each
    /// holds a live MCP session to the vendor's remote server + the
    /// tool-name → intent map. Empty when no connectors are attached. Wrapped
    /// in `Arc` because `McpSession` (an rmcp `RunningService`) is not `Clone`
    /// and `ToolCaps` must remain cheaply cloneable.
    #[allow(dead_code)]
    pub attached_connectors: std::sync::Arc<Vec<crate::connectors::AttachedConnector>>,
}

impl Default for ToolCaps {
    /// Defaults reflect the hosted-provider norm: web search available, no
    /// sandbox constraint. Local models override `web_search = false` and
    /// `requires_local_sandbox = true` via `provider_capabilities`.
    fn default() -> Self {
        ToolCaps {
            code_exec: false,
            fs_roots: Vec::new(),
            web_search: true,
            requires_local_sandbox: false,
            attached_connectors: std::sync::Arc::new(Vec::new()),
        }
    }
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
    Returns a list of result titles, URLs and snippets. This is the DEFAULT \
    search tool: a bare request like \"search X\", \"look up X\", or \"find \
    out about X\" means the WEB, not the user's files â€” use this, not \
    search_files, unless the user explicitly named a local file/extension/path. \
    Your training data has a cutoff, so CALL THIS before answering any \
    question whose answer may have changed since then: software/library/framework \
    versions or 'latest'/'current' releases, API signatures/behavior, recent \
    events or news, current prices, stats, or anything about \
    'now'/'today'/'recently'. For stable knowledge or pure reasoning (math, \
    definitions, mature syntax), do NOT search â€” just answer. For a \
    single-fact question, one targeted search is enough; only escalate to a \
    multi-source research flow if the user asked for research.";

const GENERATE_FILE_DESC: &str = "Generate a simple downloadable text-based \
    file/artifact and save it to disk. Best for plain formats: txt, md, csv, \
    json, html. ALSO use this to save SOURCE CODE: set `format` to the \
    language (e.g. \"python\", \"javascript\", \"typescript\", \"java\", \
    \"cpp\", \"csharp\", \"go\", \"rust\", \"ruby\", \"php\", \"sql\", \
    \"bash\", …) so the file gets the correct extension (main.py, App.java, \
    main.cpp) — do NOT bolt on a .txt. If you include an extension in \
    `filename`, make it the real language extension, not .txt. For a \
    professionally formatted docx/pptx/xlsx/pdf, prefer generate_document \
    instead. For pptx here, separate slides with a line containing only '---'; \
    the first line of each slide is its title and remaining lines are bullets. \
    For xlsx/csv, provide comma-separated rows (one row per line).";

const GENERATE_DOCUMENT_DESC: &str = "Create a REAL, professionally designed \
    document by writing Python that builds it, then saves it to the path in the \
    CONDUIT_OUTPUT environment variable (the requested filename inside the \
    working directory). Supports docx, pptx, xlsx and pdf. The output must look \
    polished — like something ChatGPT/Claude would produce — NOT a plain text \
    dump: a cover/title, themed colours, real typography, headings, tables, and \
    for decks multiple well-laid-out slides with a title slide and section \
    dividers.\n\n\
    Aim for an EDITORIAL, modern look like Claude/ChatGPT/Gemini ship — an \
    elegant serif display face paired with a clean sans body, generous \
    whitespace, a strong type hierarchy, ONE restrained accent colour and rich \
    full-bleed cover/section slides. Hierarchy comes from type scale, weight and \
    whitespace — NEVER from decorative accent bars, stripes or underlines under \
    titles. Clean white pages for documents; save saturated colour for deck \
    cover/section/closing slides.\n\n\
    STRONGLY PREFER the pre-installed `conduit_docgen` helper — it ships this \
    editorial system for docx, pptx AND pdf with almost no code:\n\
      import conduit_docgen as cd\n\
      doc = cd.Doc(title='Quarterly Report', subtitle='FY2025 Q2', theme='ink', author='Acme')\n\
      doc.heading('Overview'); doc.paragraph('...'); doc.bullets(['a','b']); doc.numbered(['1','2'])\n\
      doc.table(['Metric','Value'], [['Revenue','$1.2M']]); doc.callout('Key point'); doc.save()\n\
      deck = cd.Deck(title='Product Launch', subtitle='2025', theme='midnight', footer='Acme Inc')\n\
      deck.section('Introduction', number=1); deck.bullets('Why now', ['ready','mature'], eyebrow='Context')\n\
      deck.two_column('Compare','A',['fast'],'B',['robust']); deck.table_slide('Numbers',['Q','Rev'],[['Q1','1.0']])\n\
      deck.closing('Thank you','q@acme.com'); deck.save()\n\
      pdf = cd.Pdf(title='Research Brief', subtitle='...', theme='plum', author='Acme Labs')\n\
      pdf.heading('Summary'); pdf.paragraph('...'); pdf.bullets(['a','b'])\n\
      pdf.table(['Model','Latency'], [['A','12ms']]); pdf.callout('Bottom line'); pdf.save()\n\
    Themes: ink (blue-black, default), midnight (violet), emerald, plum, amber, \
    crimson, teal (older names blue/slate/green/purple/red/orange still work). \
    CHOOSE a theme that fits the subject rather than always defaulting, and vary \
    structure to fit the content instead of repeating one template. cd.Pdf \
    handles pdf via reportlab; prefer it over hand-rolled reportlab. You can \
    still access doc.document / deck.prs for raw python-docx/python-pptx tweaks. \
    For xlsx use openpyxl. Build enough real content to be genuinely useful \
    (several sections or 6+ slides for a deck). Import only from the standard \
    library, conduit_docgen, python-docx, python-pptx, openpyxl and reportlab. \
    Do not print secrets or perform network side effects.";

const GENERATE_DIAGRAM_DESC: &str = "Create a hand-styled, fully-laid-out \
    diagram as a self-contained .html file. This is the tool for EVERY diagram \
    — architecture, flowchart, sequence, feature breakdown, mind-map, anything \
    visual — with deliberate visual hierarchy: nested groupings/containers, a \
    2-D grid of sub-nodes, mixed box sizes, a bold-label-plus-dim-description \
    two-line node, solid primary-flow arrows with a dashed feedback line looping \
    back, and consistent color-per-category. \
    STRONGLY PREFER authoring the diagram as ONE root inline <svg> (with an \
    explicit xmlns, viewBox and width/height): draw nodes as <rect rx=..>, \
    labels as <text>, and connectors as <path>/<line> with an arrowhead \
    <marker>. Pure SVG is true vector, so it exports crisply to BOTH SVG and \
    PNG. Wrap that single <svg> in a minimal complete HTML document in the \
    `html` argument (a <body> holding the <svg>; put the title as a <text> at \
    the top of the SVG, above the flow). Use inline presentation only — no \
    external resources, no scripts, no CDN fonts (rely on system font \
    families). Only fall back to HTML/CSS boxes if a layout genuinely needs \
    text reflow the SVG can't do. The diagram renders inline in the chat and \
    exports to SVG and PNG. Do NOT emit ```mermaid blocks — Mermaid is not used \
    here; every diagram goes through this tool.";

const FETCH_URL_DESC: &str = "Fetch a specific web page by URL and return its \
    readable text content (HTML stripped). Use to read an article or page the \
    user linked, or a result returned by web_search.";

const RUN_CODE_DESC: &str = "Execute a short snippet of code and return its \
    output. Supports python, javascript (node) and bash. Runs locally with a \
    time limit in a temporary directory. Use for calculations, data wrangling \
    or quick scripts.";

const GET_SKILL_DESC: &str = "Load a skill's detailed instructions into your \
    context by its slug. Call this when the user's request fits one of the \
    Available skills listed in the system prompt (e.g. they ask for a Word doc \
    → get_skill(\"docx\")) and you need that skill's specific guidance, failure \
    modes, or house style before proceeding. Returns the skill body as text. \
    Only call it when a skill genuinely applies — do not call it for general \
    questions.";

const LIST_SKILLS_DESC: &str = "List every available skill slug.";

const LIST_DIRECTORY_DESC: &str = "List the immediate children of a directory \
    (files and subdirectories, one per line). Pass an absolute path. Read-only.";

const READ_FILE_DESC: &str = "Read a file's text contents and return them \
    (truncated to a reasonable length). Pass an absolute path. Read-only. Best \
    for text/code files; binary files are not decoded.";

const SEARCH_FILES_DESC: &str = "Recursively find LOCAL files under a directory whose \
    path/name contains a substring (case-insensitive). Returns matching paths, \
    capped to a reasonable number. Read-only. Use this ONLY for the user's local \
    files â€” NOT for web/knowledge lookups; a bare topic like \"cow\" is a web \
    search, not a file search. Call web_search instead unless the user named a \
    file/extension/path or clearly means local content. For searching the \
    **contents** of files (where is X defined / used), prefer `search_content`.";

const SEARCH_CONTENT_DESC: &str = "Search the **content** of files under a directory for a \
    substring (default) or regex. Returns matches as `path:line:col: matched-line`, one per \
    line, capped to max_results (default 100). This is the DEFAULT tool for 'find where X \
    is defined/used' and 'grep through my code' — call this whenever the user is looking \
    inside files, not at their names. Supports `glob` (e.g. `*.rs`, `**/test_*.py`), \
    `case_insensitive`, and a `regex` mode (regex crate syntax). Skips build/cache \
    directories (node_modules, .git, target, dist, __pycache__, vendor, etc.) so a \
    broad sweep stays fast. Read-only.";

const WRITE_FILE_DESC: &str = "Create or overwrite a file with the given text \
    content. Pass an absolute path. Mutating — may require approval depending \
    on the session's permission mode. Creates parent directories as needed.";

const EDIT_FILE_DESC: &str = "Edit an existing file by replacing the first \
    occurrence of `find` with `replace`, or append to it when `append` is set. \
    Pass an absolute path. Mutating.";

const DELETE_FILE_DESC: &str = "Delete a file (or an empty directory). Pass an \
    absolute path. Mutating — ALWAYS requires explicit per-action approval, \
    regardless of the session's permission mode.";

const MOVE_FILE_DESC: &str = "Move or rename a file/directory from `src` to \
    `dest` (both absolute). Mutating.";

const COPY_FILE_DESC: &str = "Copy a file from `src` to `dest` (both absolute). \
    Mutating.";

const BROWSER_READ_DESC: &str = "Inspect the page currently open in the app's \
    built-in browser pane. Returns structured Markdown (headings, paragraphs, \
    lists, tables, links) plus metadata (title, URL, canonical URL, publish date, \
    byline) and a numbered list of interactive elements (links, buttons, inputs) \
    — each with a `ref` number for browser_click/browser_type. Call this first \
    (after open_url) and again after any click/type to get the fresh element map. \
    Supports three modes: `full` (default, complete cleaned article text), \
    `summary_only` (just the headings structure + first ~1500 chars of body — for \
    context-budget triage before committing to a full read), and `section` \
    (extract only content under a CSS selector or heading text). In case of \
    extraction failure, a `failureReason` field is set (`paywalled`, \
    `login_required`, `extraction_failed`, `blocked` or null). Consent/cookie \
    banners are auto-dismissed before extraction. Lazy-loaded content is surfaced \
    via a bounded scroll loop.";

const BROWSER_CLICK_DESC: &str = "Click an element in the built-in browser pane \
    by its `ref` number (from the most recent browser_read). Use for links, \
    buttons, and submit controls. The ref map changes when the page changes, so \
    always browser_read again afterwards.";

const BROWSER_TYPE_DESC: &str = "Type text into an input/textarea in the \
    built-in browser pane by its `ref` number (from the most recent \
    browser_read). Sets the field value and fires input/change events. Follow \
    with a browser_click on the search/submit button (or another browser_read).";

const BROWSER_SCROLL_DESC: &str = "Scroll the page in the built-in browser pane \
    vertically by `amount` pixels (negative scrolls up). Use to reveal content \
    below the fold before reading again.";

const BROWSER_SCREENSHOT_DESC: &str = "Take a screenshot of the page currently \
    open in the built-in browser pane. Saves a PNG to the artifacts dir and \
    returns its path — embed it in your reply as ![screenshot](path) so the \
    user sees exactly what the page looks like. Use after open_url/browser_click \
    when you need visual confirmation of the rendered page (layout, dialogs, \
    error states), or whenever the user asks to see the page.";

const OPEN_URL_DESC: &str = "Open a web page in the app's built-in browser so \
    the user can see it, and return its readable text to you. Use when the user \
    asks to open/show/visit a site, or when it helps to display a page visually \
    alongside your answer.";

const DOWNLOAD_FILE_DESC: &str = "Stream a file from an http(s) URL to an \
    absolute local path on this machine (e.g. model weights such as \
    .safetensors / .bin directly from Hugging Face repositories). This is a \
    REAL, working tool: call it, and the file is downloaded in the background \
    to the path you give (any drive or directory — no sandbox restriction), \
    then you can report progress and the result to the user. Returns a task id \
    immediately; poll `download_progress` with that id for live bytes/percent, \
    and report when it completes. The download is resumable (a .part file is \
    kept on cancel/failure), so a retry continues instead of restarting. \
    Mutating — a write to disk, gated by the session's permission mode. Use \
    this for ANY file a user wants saved locally from a URL.";

const DOWNLOAD_PROGRESS_DESC: &str = "Report the live progress of a background \
    download started by `download_file`. Pass the task id returned by \
    `download_file`. Returns bytes downloaded, total bytes (when known), \
    percentage, speed, and the final state. This is the tool for tracking \
    multi-gigabyte transfers and handling retry/resume states. Read-only. If \
    the user asked you to download a file, call this repeatedly (a few seconds \
    apart) and report progress to them until the task completes.";

const RUN_SHELL_DESC: &str = "Run a native shell command on the user's machine \
    (cmd.exe on Windows, sh on Unix) and capture its output. This is a REAL, \
    working tool — it executes unsandboxed with the user's privileges and can \
    access any local working directory, so CLI tools like `huggingface-cli \
    download`, git, pip, ffmpeg, etc. work exactly as they do in a terminal. \
    The command runs to completion and its combined stdout/stderr is returned \
    directly (the output is also shown in the chat). Don't use this for \
    long-running commands that never exit on their own (e.g. a dev server) — \
    they will block the turn; prefer a one-shot invocation that finishes. \
    ALWAYS gated on an approval card before it runs. Use this when a task \
    needs a native CLI tool that `download_file` (URL → file) or `run_code` \
    (sandboxed snippet) cannot express. Prefer `download_file` for plain URL \
    downloads, and `run_code` for small self-contained scripts.";

const TASK_DESC: &str = "Spawn a focused subagent that runs ONE task with its \
    own model turn and reports back. Use this to delegate a self-contained \
    sub-task (explore a codebase, research a topic, draft a section) so the \
    main turn stays lean. The subagent runs the SAME provider+model as this \
    session, gets the `prompt` as its sole user message, and its output is \
    streamed live to the Agents panel. The subagent's final text is returned \
    to you as the tool result. Keep prompts self-contained — the subagent \
    does NOT see this conversation's history.";

const GET_TASK_STATUS_DESC: &str = "Report the status of any background task \
    (`download_file` or `run_shell`) by its task id: state (running/completed/\
    failed/cancelled), progress numbers, and the output or error message. \
    Read-only. Poll this while a task is running to track it.";

const CANCEL_TASK_DESC: &str = "Cancel a background task started in this \
    conversation by its task id. For downloads this keeps the .part file so a \
    later retry resumes instead of restarting; for shell commands it kills the \
    process. Use when the user changes their mind or a task is stalled.";

const ADD_SOURCE_NOTE_DESC: &str = "Record ONE concrete fact you extracted from a \
    research source, so it is preserved in the source ledger for this chat session \
    (instead of relying on conversation memory). Call this once per distinct fact \
    worth keeping — a single page read may produce several notes, or none. Take \
    `url` and `title` from the page's `browser_read` (or `fetch_url`) result; set \
    `fact` to a single sentence, and `excerpt` to a SHORT VERBATIM QUOTE from the \
    page that supports the fact (do not paraphrase at this stage — paraphrasing \
    happens at synthesis). Set `unavailable` to the `browser_read` `failureReason` \
    (\"paywalled\", \"login_required\", \"extraction_failed\", \"blocked\") when the \
    source could not be read, so the gap surfaces in the final Sources section \
    rather than being silently skipped.";

const GET_SOURCE_LEDGER_DESC: &str = "Re-read every source note you have recorded \
    for this chat session, returned as a JSON array (each entry: url, title, fact, \
    excerpt, unavailable, createdAt). Call this during synthesis to write the final \
    answer and its Sources section FROM THE LEDGER, not from conversation memory.";

const RESET_SOURCE_LEDGER_DESC: &str = "Clear every source note recorded for this \
    chat session. Call this at the START of each new research task so a fresh \
    question begins from a clean ledger (notes from a previous, unrelated question \
    are discarded).";

/// Run a blocking (sync, unbounded-walk) tool implementation on the dedicated
/// blocking pool instead of the async runtime. A JoinHandle panic surfaces as
/// an error string rather than killing the dispatching task.
async fn run_blocking_tool(
    args: &Value,
    f: fn(&Value) -> ToolOutcome,
) -> ToolOutcome {
    let a = args.clone();
    match tokio::task::spawn_blocking(move || f(&a)).await {
        Ok(out) => out,
        Err(e) => ToolOutcome::text(format!("Error: tool task failed: {e}")),
    }
}

/// Dispatch a tool call to its implementation. `args` is the JSON object of
/// arguments the model produced. Returns the tool result as a string that is
/// fed back to the model as a `tool` / `tool_result` message.
pub async fn execute_tool(
    client: &reqwest::Client,
    artifacts_dir: &Path,
    caps: &ToolCaps,
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
        GET_SKILL => {
            // Auto-trigger: let the model pull a skill's body on demand when a
            // request fits one, instead of requiring the user to type `/slug`.
            // Read-only (no FS/DB mutation) so it stays available under every
            // permission mode. See `installed_skills::read_skill_body`.
            let slug = args.get("slug").and_then(|v| v.as_str()).unwrap_or("").trim();
            if slug.is_empty() {
                ToolOutcome::text("Error: get_skill requires a \"slug\" argument.")
            } else {
                match crate::installed_skills::read_skill_body(slug) {
                    Some(body) => ToolOutcome::text(body),
                    None => ToolOutcome::text(format!(
                        "No skill named \"{slug}\". The available skills are listed in the system prompt under \"## Available skills\"."
                    )),
                }
            }
        }
        LIST_SKILLS => {
            // Read-only (no FS/DB mutation) so it stays available under every
            // permission mode, mirroring get_skill. Same source as the chat
            // `/` menu and the harness system prompt: on-disk skills first,
            // built-ins (docx/pptx/pdf/diagram) when not shadowed.
            let skills = crate::installed_skills::list_all_skills();
            if skills.is_empty() {
                ToolOutcome::text("No skills available.")
            } else {
                ToolOutcome::text(
                    skills
                        .iter()
                        .map(|s| format!("{} — {}", s.slug, s.name))
                        .collect::<Vec<_>>()
                        .join("\n"),
                )
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
        // ---- Filesystem tools ----
        // The permission gate (which mode auto-runs vs. queues an approval card)
        // is enforced by the caller BEFORE reaching here — these branches only
        // run for actions that have been authorized (auto-run, or approved by
        // the user). `read_only` mode additionally strips the mutating tools
        // from the schema so the model can't even call them.
        LIST_DIRECTORY => fs_list_directory(args),
        READ_FILE => fs_read_file(args),
        // The two recursive scans walk unbounded trees (search_content reads
        // up to 5 MiB per file) — running them inline on the async runtime
        // stalls the tokio worker and delays every other task (chat streams,
        // PTY, IPC). Push the blocking walk to the dedicated pool.
        SEARCH_FILES => run_blocking_tool(args, fs_search_files).await,
        SEARCH_CONTENT => run_blocking_tool(args, fs_search_content).await,
        WRITE_FILE => fs_write_file(args),
        EDIT_FILE => fs_edit_file(args),
        DELETE_FILE => fs_delete_file(args),
        MOVE_FILE => fs_move_file(args),
        COPY_FILE => fs_copy_file(args),
        other => ToolOutcome::text(format!("Error: unknown tool \"{other}\".")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::permission::PermissionMode;

    fn openai_names(caps: &ToolCaps, mode: PermissionMode) -> Vec<String> {
        openai_tool_specs(caps, mode)
            .iter()
            .map(|s| s["function"]["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn openai_spec_lists_safe_tools() {
        let names = openai_names(&ToolCaps::default(), PermissionMode::Manual);
        assert!(names.contains(&WEB_SEARCH.to_string()));
        assert!(names.contains(&GENERATE_FILE.to_string()));
        assert!(names.contains(&FETCH_URL.to_string()));
        assert!(!names.contains(&RUN_CODE.to_string()));
        let specs = openai_tool_specs(&ToolCaps::default(), PermissionMode::Manual);
        assert_eq!(specs[0]["type"], "function");
        assert!(specs[0]["function"]["parameters"]["properties"]["query"].is_object());
    }

    #[test]
    fn generate_diagram_listed_as_safe_tool() {
        assert!(
            openai_names(&ToolCaps::default(), PermissionMode::Manual)
                .contains(&GENERATE_DIAGRAM.to_string())
        );
        let a = anthropic_tool_specs(&ToolCaps::default(), PermissionMode::Manual);
        assert!(a.iter().any(|s| s["name"] == GENERATE_DIAGRAM));
        // The diagram tool must expose filename + html args.
        let binding = openai_tool_specs(&ToolCaps::default(), PermissionMode::Manual);
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
            &ToolCaps::default(),
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
            &ToolCaps::default(),
            GENERATE_DIAGRAM,
            &json!({ "filename": "x", "html": "" }),
        ));
        assert!(out.artifact.is_none());
        assert!(out.text.contains("requires non-empty"));
    }


    #[test]
    fn browser_read_is_listed_in_openai_spec_with_parameters() {
        let specs = openai_tool_specs(&ToolCaps::default(), PermissionMode::Manual);
        let read_spec = specs
            .iter()
            .find(|s| s["function"]["name"] == BROWSER_READ)
            .expect("browser_read must be in the tool spec");
        let params = &read_spec["function"]["parameters"];
        assert!(params["properties"]["mode"].is_object(), "browser_read must have mode parameter");
        assert!(params["properties"]["selector"].is_object(), "browser_read must have selector parameter");
    }

    #[test]
    fn browser_read_is_listed_in_anthropic_spec_with_parameters() {
        let specs = anthropic_tool_specs(&ToolCaps::default(), PermissionMode::Manual);
        let read_spec = specs
            .iter()
            .find(|s| s["name"] == BROWSER_READ)
            .expect("browser_read must be in the Anthropic tool spec");
        let params = &read_spec["input_schema"];
        assert!(params["properties"]["mode"].is_object(), "expected mode property in input_schema, got: {params}");
        assert!(params["properties"]["selector"].is_object(), "expected selector property in input_schema, got: {params}");
    }

    #[test]
    fn ledger_tools_listed_in_both_specs() {
        // The three source-ledger tools are always on (state tools, not gated
        // by permission mode) and must appear in both provider specs.
        for mode in [PermissionMode::Manual, PermissionMode::ReadOnly] {
            let o = openai_names(&ToolCaps::default(), mode);
            assert!(o.contains(&ADD_SOURCE_NOTE.to_string()), "openai {mode:?}: add_source_note missing");
            assert!(o.contains(&GET_SOURCE_LEDGER.to_string()));
            assert!(o.contains(&RESET_SOURCE_LEDGER.to_string()));
            let a = anthropic_tool_specs(&ToolCaps::default(), mode);
            let an: Vec<&str> = a.iter().map(|s| s["name"].as_str().unwrap()).collect();
            assert!(an.contains(&ADD_SOURCE_NOTE));
            assert!(an.contains(&GET_SOURCE_LEDGER));
            assert!(an.contains(&RESET_SOURCE_LEDGER));
        }
    }


    #[test]
    fn run_code_gated_behind_capability() {
        assert!(!openai_names(&ToolCaps::default(), PermissionMode::Manual).contains(&RUN_CODE.to_string()));
        assert!(openai_names(&ToolCaps { code_exec: true, ..Default::default() }, PermissionMode::Manual).contains(&RUN_CODE.to_string()));
    }

    #[test]
    fn open_url_listed_as_safe_tool() {
        assert!(openai_names(&ToolCaps::default(), PermissionMode::Manual).contains(&OPEN_URL.to_string()));
    }

    #[test]
    fn open_url_rejects_non_http() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir();
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            &ToolCaps::default(),
            OPEN_URL,
            &json!({ "url": "ftp://example.com" }),
        ));
        assert!(out.browse_url.is_none());
        assert!(out.text.contains("http(s)"));
    }

    #[test]
    fn anthropic_spec_lists_safe_tools() {
        let specs = anthropic_tool_specs(&ToolCaps::default(), PermissionMode::Manual);
        let names: Vec<&str> = specs.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert!(names.contains(&WEB_SEARCH));
        assert!(names.contains(&FETCH_URL));
        assert!(!names.contains(&RUN_CODE));
        assert!(specs[0]["input_schema"]["properties"]["query"].is_object());
    }

    #[test]
    fn code_exec_rejected_when_capability_off() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir();
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            &ToolCaps::default(),
            RUN_CODE,
            &json!({ "language": "python", "code": "print(1)" }),
        ));
        assert!(out.text.contains("code execution is disabled"));
    }

    #[test]
    #[ignore = "hits the live network"]
    fn web_search_live_returns_results() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir();
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            &ToolCaps::default(),
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
            &ToolCaps::default(),
            "does_not_exist",
            &json!({}),
        ));
        assert!(out.text.contains("unknown tool"));
    }

    #[test]
    fn list_skills_returns_docx_slug() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir();
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            &ToolCaps::default(),
            LIST_SKILLS,
            &json!({}),
        ));
        // The built-in docx skill always exists (even when shadowed by an
        // on-disk override the slug is preserved), so the listing must
        // mention it.
        assert!(
            out.text.contains("docx"),
            "list_skills output must include the docx slug, got: {}",
            out.text
        );
        assert!(out.artifact.is_none());
        // The read-only tool must be surfaced in both provider specs.
        let o = openai_names(&ToolCaps::default(), PermissionMode::Manual);
        assert!(o.contains(&LIST_SKILLS.to_string()));
        let a = anthropic_tool_specs(&ToolCaps::default(), PermissionMode::Manual);
        assert!(a.iter().any(|s| s["name"] == LIST_SKILLS));
    }

    // ---- Filesystem tool + permission-mode tests ----

    #[test]
    fn read_only_mode_strips_mutating_fs_tools_from_schema() {
        // The acceptance test: under read_only, write_file/edit_file/delete_file/
        // move_file/copy_file must be ABSENT from the tool schema (schema-level
        // exclusion, not a UI block) — the model literally cannot invoke them.
        let names = openai_names(&ToolCaps::default(), PermissionMode::ReadOnly);
        assert!(!names.contains(&WRITE_FILE.to_string()), "write_file must be absent under read_only");
        assert!(!names.contains(&EDIT_FILE.to_string()));
        assert!(!names.contains(&DELETE_FILE.to_string()));
        assert!(!names.contains(&MOVE_FILE.to_string()));
        assert!(!names.contains(&COPY_FILE.to_string()));
        // Read-only FS tools are still present.
        assert!(names.contains(&LIST_DIRECTORY.to_string()));
        assert!(names.contains(&READ_FILE.to_string()));
        assert!(names.contains(&SEARCH_FILES.to_string()));
    }

    #[test]
    fn manual_mode_includes_mutating_fs_tools() {
        let names = openai_names(&ToolCaps::default(), PermissionMode::Manual);
        assert!(names.contains(&WRITE_FILE.to_string()));
        assert!(names.contains(&DELETE_FILE.to_string()));
    }

    #[test]
    fn anthropic_read_only_also_strips_mutating_fs_tools() {
        let specs = anthropic_tool_specs(&ToolCaps::default(), PermissionMode::ReadOnly);
        let names: Vec<&str> = specs.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert!(!names.contains(&WRITE_FILE));
        assert!(names.contains(&READ_FILE));
    }

    // ---- system tools (downloads + native shell) ----

    #[test]
    fn system_tools_listed_in_openai_specs() {
        let names = openai_names(&ToolCaps::default(), PermissionMode::Manual);
        assert!(names.contains(&DOWNLOAD_FILE.to_string()));
        assert!(names.contains(&DOWNLOAD_PROGRESS.to_string()));
        assert!(names.contains(&RUN_SHELL.to_string()));
        assert!(names.contains(&GET_TASK_STATUS.to_string()));
        assert!(names.contains(&CANCEL_TASK.to_string()));
        // The download tool must expose url + dest_path args.
        let specs = openai_tool_specs(&ToolCaps::default(), PermissionMode::Manual);
        let spec = specs
            .iter()
            .find(|s| s["function"]["name"] == DOWNLOAD_FILE)
            .expect("download_file must be in the spec")["function"]["parameters"]
            .clone();
        assert!(spec["properties"]["url"].is_object());
        assert!(spec["properties"]["dest_path"].is_object());
        assert!(spec["required"].as_array().unwrap().contains(&json!("url")));
    }

    #[test]
    fn system_tools_listed_in_anthropic_specs() {
        let specs = anthropic_tool_specs(&ToolCaps::default(), PermissionMode::Manual);
        let names: Vec<&str> = specs.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert!(names.contains(&DOWNLOAD_FILE));
        assert!(names.contains(&RUN_SHELL));
        assert!(names.contains(&CANCEL_TASK));
    }

    #[test]
    fn read_only_strips_mutating_system_tools_but_keeps_tracking() {
        // read_only must drop download_file + run_shell from the schema
        // (like write_file) while keeping the read-only tracking tools.
        let names = openai_names(&ToolCaps::default(), PermissionMode::ReadOnly);
        assert!(!names.contains(&DOWNLOAD_FILE.to_string()), "download_file must be absent under read_only");
        assert!(!names.contains(&RUN_SHELL.to_string()), "run_shell must be absent under read_only");
        assert!(names.contains(&DOWNLOAD_PROGRESS.to_string()));
        assert!(names.contains(&GET_TASK_STATUS.to_string()));
        assert!(names.contains(&CANCEL_TASK.to_string()));
    }

}
