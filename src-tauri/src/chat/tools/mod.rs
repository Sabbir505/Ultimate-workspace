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
/// Open a LOCAL file with the OS default application (the `open` crate:
/// xdg-open / open / start). Complements `open_url`, which is web-only.
pub const OPEN_FILE: &str = "open_file";
pub const GET_SKILL: &str = "get_skill";
pub const LIST_SKILLS: &str = "list_skills";
/// Attach-on-demand meta-tools: load a connector's / MCP server's tools into
/// this conversation (see specs.rs and dispatch.rs). Advertised with an enum
/// of attachable ids; a fresh turn ships no connector schemas at all.
pub const ATTACH_CONNECTOR: &str = "attach_connector";
pub const ATTACH_MCP_SERVER: &str = "attach_mcp_server";
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

// ---- Structured plan tracking ----
//
// Session-state tools dispatched in chat/plan.rs (NOT via execute_tool — they
// need PlanState +, for present_plan, the approval oneshot). The todo list is
// the model-declared progress state the UI renders; plan mode gates mutations
// behind an approved plan. Dispatched before every other tool family in
// run_tool, and never permission-gated (they change no user data).

/// Rewrite the model's whole task list for the session. The authoritative
/// progress state — the UI renders it as a live checklist.
pub const TODO_WRITE: &str = "todo_write";
/// Model-initiated plan mode: flips the session read-only so the model can
/// research, then propose a plan for approval.
pub const ENTER_PLAN_MODE: &str = "enter_plan_mode";
/// Propose the plan as an approval card; the turn pauses until the user
/// approves (unlocks mutations) or rejects with feedback.
pub const PRESENT_PLAN: &str = "present_plan";

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
/// Search the local-doc corpora the user indexed from Settings → Knowledge.
/// Returns path/type/score headers with the matching text excerpt per hit;
/// image results include a path citation only (no inline content). Available
/// only while the embedding sidecar is reachable and at least one corpus has
/// been indexed — gated per turn by `ToolCaps.local_docs`.
pub const SEARCH_DOCS: &str = "search_docs";
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
    /// Whether the local-docs `search_docs` tool is exposed this turn. True only
    /// when the embedding sidecar is running AND at least one enabled corpus
    /// has indexed chunks. Computed per turn in chat/mod.rs from DB + registry.
    pub local_docs: bool,
    /// MCP-gallery servers attached to this turn (§3.2.14): every ENABLED
    /// installed server's tools, under prefixed wire names (`mcp_<server>_
    /// <tool>`). Unlike connectors these are global (not per-conversation)
    /// — mirroring how Cline treats global MCP config. The dispatcher
    /// resolves the wire name to the live session via the gallery registry.
    pub mcp_tools: std::sync::Arc<Vec<crate::mcp_gallery::McpToolEntry>>,
    /// User-defined approval rules ("always allow tool + glob") loaded per turn
    /// from `app_settings` (`permissions.rules`). A matching rule auto-approves
    /// the filesystem permission gate; the hard `path_within_scope` gate still
    /// applies, so rules never grant writes outside the enabled/dir scope.
    pub fs_rules: Vec<crate::chat::permission::ApprovalRule>,
    /// Attach-on-demand catalog: (id, display name) of connectors that are
    /// available (credentialed or public) but NOT attached this turn. Non-empty
    /// → the `attach_connector` meta-tool is advertised with these ids as its
    /// enum; the full tool schemas stay out of the request until attached.
    pub attachable_connectors: std::sync::Arc<Vec<(String, String)>>,
    /// Same contract for enabled-but-not-attached MCP-gallery servers
    /// (`attach_mcp_server`).
    pub attachable_mcp: std::sync::Arc<Vec<(String, String)>>,
    /// True for small-context local models: connector/MCP vendor tool
    /// descriptions are hard-truncated (see specs.rs) so an attached source
    /// can't blow the window the attach-on-demand design just saved.
    pub local_model: bool,
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
            local_docs: false,
            mcp_tools: std::sync::Arc::new(Vec::new()),
            fs_rules: Vec::new(),
            attachable_connectors: std::sync::Arc::new(Vec::new()),
            attachable_mcp: std::sync::Arc::new(Vec::new()),
            local_model: false,
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
    /// Ask the UI to open this LOCAL file in the right-side tool-panel
    /// preview (`open_file` for extensions the app previews natively).
    pub preview: Option<ArtifactRef>,
}

impl ToolOutcome {
    fn text(t: impl Into<String>) -> Self {
        Self {
            text: t.into(),
            artifact: None,
            browse_url: None,
            preview: None,
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

/// Description fed to the model for the local-docs `search_docs` tool. Kept
/// distinct from `web_search` so the model doesn't conflate the two.
const SEARCH_DOCS_DESC: &str = "Search the user's locally-indexed document folders \
    (the corpora added in Settings → Knowledge). Use this when the user wants an \
    answer drawn from THEIR OWN files, notes, or codebase docs rather than the \
    public web — e.g. 'what did I write about X', 'find my notes on Y', 'does \
    this project document Z'. Returns ranked hits, each with the relative \
    file path, a type tag and a relevance score, plus the matching text \
    excerpt. Image hits return the path only (no inline pixels). If nothing \
    matches, say so plainly rather than inventing content.";

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

const GENERATE_DOCUMENT_DESC: &str = "Create a professionally designed \
    docx/pptx/xlsx/pdf by writing a complete Python program in `code` that \
    builds it and saves it to os.environ[\"CONDUIT_OUTPUT\"] (the requested \
    filename). STRONGLY PREFER the pre-installed `conduit_docgen` helper \
    (themes: ink, midnight, emerald, plum, amber, crimson, teal). The output \
    must look polished — never a plain text dump. The full editorial style \
    guide + conduit_docgen cheatsheet is returned with the tool result; read \
    it and regenerate if the first attempt falls short. Imports allowed: \
    stdlib, conduit_docgen, python-docx, python-pptx, openpyxl, reportlab.";

const GENERATE_DIAGRAM_DESC: &str = "Create a freeform STATIC vector illustration \
    (concept sketch, annotated architecture art) as a self-contained .html file. \
    Author it as ONE root inline <svg> (explicit xmlns, viewBox, width/height): \
    nodes as <rect rx=..>, labels as <text>, connectors as <path>/<line> with an \
    arrowhead <marker>; wrap that svg in a minimal complete HTML document in the \
    `html` argument. Inline presentation only — no external resources, scripts, \
    or CDN fonts. For structured graph diagrams (flowchart, sequence, ER, state, \
    mind-map) prefer a ```mermaid block — Mermaid auto-layouts and renders live in \
    the chat. For charts/dashboards prefer a .tsx file via write_file (the preview \
    sandbox ships recharts/d3/lucide-react). The full routing + layout guide is \
    returned with the tool result; regenerate if the first attempt looks flat.";

const FETCH_URL_DESC: &str = "Fetch a specific web page by URL and return its \
    readable text content (HTML stripped). You CAN open any public web URL \
    with this — never claim you can't open pages or browse. Use to read an \
    article or page the user linked, or a result returned by web_search.";

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

const ATTACH_CONNECTOR_DESC: &str = "Load a connected app's tools into this \
    conversation (Gmail, Notion, Drive, … — see \"Connected apps & servers\" in the \
    system prompt for ids). The app's tools become callable immediately and stay \
    attached for the conversation. Call this FIRST when a request needs one of \
    the listed services; never claim the service is unavailable before attaching.";

const ATTACH_MCP_SERVER_DESC: &str = "Load an installed MCP server's tools into \
    this conversation (see \"Connected apps & servers\" in the system prompt for \
    ids). Same contract as attach_connector: tools become callable immediately \
    and stay attached for the conversation.";

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
    on the session's permission mode. Creates parent directories as needed. \
    Visual routing: charts/dashboards → a .tsx component importing recharts / \
    d3 / lucide-react (pre-installed in the live preview sandbox, default-export \
    the component); interactive HTML explainers → a single .html file (external \
    libraries only from https://cdnjs.cloudflare.com); Mermaid graph diagrams → \
    a .mmd file or a ```mermaid block.";

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
    the user can see it, and return its readable text to you. You CAN open \
    any public web URL with this — never claim you can't open sites. Use \
    when the user asks to open/show/visit a site, or when it helps to \
    display a page visually alongside your answer. This is for WEB URLs only: \
    to open a LOCAL file (something you created or an existing document) use \
    the open_file tool instead; never open file:// paths here, never start a \
    local server to serve a generated file, and never use this to \"open\" \
    something the user asked you to create — created files preview \
    automatically in the app.";

/// Files the app previews natively in the right-side tool panel — `open_file`
/// routes these to the in-app preview instead of the OS handler (for a .mmd
/// diagram the OS just shows an "open with" picker over unusable apps).
/// Covers the media/PDF extensions plus every text kind `read_artifact_preview`
/// classifies (code, markdown, html, mermaid, csv, json, …).
fn previewable_in_app(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "pdf"
    ) || crate::chat::commands::classify_text_ext(ext).is_some()
}

const OPEN_FILE_DESC: &str = "Open a file the user asked to see. Previewable files \
    (code/text/markdown/html/mermaid diagrams/csv/json/images/pdf) open INSIDE \
    the app in the right-side preview panel — prefer this for anything you \
    created (e.g. a saved .mmd/.svg/.html diagram); the user sees it \
    immediately, no external app involved. Anything else (.exe, .docx, media \
    the app can't render) opens with the OS default application. Pass the \
    file's ABSOLUTE path. Never use run_shell/start to open files — this tool \
    is the way; for web pages use open_url instead (it is http(s)-only).";

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

const DOWNLOAD_PROGRESS_DESC: &str = "Report a `download_file` task's live \
    progress (bytes, percentage, speed, final state). Poll every few seconds \
    and report to the user until it completes.";

const RUN_SHELL_DESC: &str = "Run a native shell command (cmd.exe / sh) with \
    the user's privileges and return combined stdout/stderr — CLI tools like \
    git, pip, ffmpeg work as in a terminal. One-shot commands only (nothing \
    long-running like a dev server). ALWAYS approval-gated. Prefer \
    `download_file` for plain URL downloads and `run_code` for sandboxed \
    snippets. NEVER use this to open/launch a file for the user (no `start`, \
    `open`, `xdg-open`) — that is exactly what the `open_file` tool does, \
    and shell quoting around `start` only produces Windows 'cannot find' \
    errors.";

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

const ADD_SOURCE_NOTE_DESC: &str = "Record ONE concrete fact from a research \
    source into the session's source ledger. One note per distinct fact; take \
    url/title from the browser_read/fetch_url result, keep `excerpt` a SHORT \
    VERBATIM quote, and set `unavailable` to the failureReason when the page \
    couldn't be read.";

const GET_SOURCE_LEDGER_DESC: &str = "Re-read every source note you have recorded \
    for this chat session, returned as a JSON array (each entry: url, title, fact, \
    excerpt, unavailable, createdAt). Call this during synthesis to write the final \
    answer and its Sources section FROM THE LEDGER, not from conversation memory.";

const RESET_SOURCE_LEDGER_DESC: &str = "Clear every source note recorded for this \
    chat session. Call this at the START of each new research task so a fresh \
    question begins from a clean ledger (notes from a previous, unrelated question \
    are discarded).";

const TODO_WRITE_DESC: &str = "Create or update your task list for the current \
    task. Use it for any multi-step work (2+ distinct steps or files); skip it \
    for trivial single-step answers. Rules: rewrite the WHOLE list on every \
    call (it replaces the previous one); at most one item in_progress at a \
    time; mark an item completed IMMEDIATELY after finishing it, not in \
    batches; revise the list whenever scope changes. The list is rendered to \
    the user as a live progress tracker — do not repeat it in your reply.";

const ENTER_PLAN_MODE_DESC: &str = "Switch this session into plan mode before \
    starting complex or risky work: multiple files/steps, ambiguous \
    requirements, or hard-to-reverse actions (deletes, moves, migrations, \
    shell commands). In plan mode you research with read-only tools (file \
    reads, search, web) — mutating tools are blocked until the user approves a \
    plan via present_plan. Do NOT use it for quick questions, single-file \
    tweaks, or pure research; and if you have ALREADY started making changes, \
    keep going and track progress with todo_write instead.";

const PRESENT_PLAN_DESC: &str = "Present your PLAN for the user's approval \
    (plan mode only). `plan` is the detailed APPROACH in markdown — what \
    you'll change, how, and how you'll verify — NOT a step checklist. Shown \
    as an approval card; the turn pauses until the user decides. Approved: \
    plan mode exits, then break the plan into concrete steps with todo_write \
    and execute. Rejected: the result contains the user's feedback — revise \
    and present again. Call it BEFORE making any changes, never after work \
    has started. Do NOT also write the plan out in your reply — the card \
    renders it; a one-line acknowledgment is enough.";

/// Shared `items` array schema for todo_write (required) and present_plan
/// (optional-present — the handler falls back to the current list). `required`
/// controls whether `items` sits in the schema's `required` array.
fn todo_items_parameters(required: bool) -> Value {
    json!({
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "description": "The FULL step list — every call rewrites the whole list.",
                "items": {
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "Short imperative step label, e.g. \"Write the parser module\"."
                        },
                        "status": {
                            "type": "string",
                            "enum": ["pending", "in_progress", "completed"],
                            "description": "Defaults to pending."
                        },
                        "active_form": {
                            "type": "string",
                            "description": "Present-continuous label shown while this step runs, e.g. \"Writing parser\"."
                        }
                    },
                    "required": ["content"]
                }
            }
        },
        "required": if required { vec!["items"] } else { vec![] }
    })
}

fn enter_plan_mode_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "description": "One line on why this task needs an approved plan."
            }
        }
    })
}

/// present_plan's schema: the plan is an approach DOCUMENT (markdown), not a
/// step list — steps come later via todo_write, after approval.
fn plan_text_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "plan": {
                "type": "string",
                "description": "The detailed approach as markdown: what you'll change, how, key files/components, and how you'll verify. Design, not a step checklist."
            },
            "title": {
                "type": "string",
                "description": "Short heading for the approval card. Defaults to the plan's first heading/line."
            }
        },
        "required": ["plan"]
    })
}

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
///
/// `app` is `Some` in every live turn (chat, relay MCP, subagent); unit tests
/// pass `None`, and the tools that need an app window (the HTML→PDF print
/// engine, the JavaScript document runner) report a Python-fallback hint when
/// it's absent.
pub async fn execute_tool(
    client: &reqwest::Client,
    artifacts_dir: &Path,
    caps: &ToolCaps,
    name: &str,
    args: &Value,
    app: Option<&tauri::AppHandle>,
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
        GENERATE_DOCUMENT => generate_document(app, artifacts_dir, args).await,
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
                    preview: None,
                },
                // Even if reading fails, still show the page to the user.
                Err(e) => ToolOutcome {
                    text: format!("Opened {normalized} in the built-in browser (could not extract text: {e})."),
                    artifact: None,
                    browse_url: Some(normalized),
                    preview: None,
                },
            }
        }
        OPEN_FILE => {
            let raw = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
            if raw.is_empty() {
                return ToolOutcome::text("Error: open_file requires a \"path\".");
            }
            let p = std::path::Path::new(raw);
            if !p.is_absolute() {
                return ToolOutcome::text(format!(
                    "Error: open_file needs an ABSOLUTE path (got \"{raw}\"). \
                     Use the full path you wrote the file to."
                ));
            }
            if !p.is_file() {
                return ToolOutcome::text(format!(
                    "Error: open_file: no file exists at \"{raw}\". Verify the path \
                     (search_files can locate it), then retry."
                ));
            }
            let filename = p
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| raw.to_string());
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            // Files the app previews natively (code/text/html/diagrams/images/
            // pdf) open in the right-side tool panel — for a .mmd diagram the
            // OS handler is just an "open with" picker over unusable apps.
            if previewable_in_app(&ext) {
                return ToolOutcome {
                    text: format!(
                        "Opened {raw} in the app's file-preview panel (the user sees \
                         it in the right-side tool pane now)."
                    ),
                    artifact: None,
                    browse_url: None,
                    preview: Some(ArtifactRef {
                        path: raw.to_string(),
                        filename,
                    }),
                };
            }
            let target = raw.to_string();
            // Launching the OS handler can block briefly — keep it off the
            // async runtime (same pattern as the other blocking tools).
            match tokio::task::spawn_blocking(move || open::that(&target)).await {
                Ok(Ok(_)) => ToolOutcome::text(format!(
                    "Opened {raw} with the OS default application."
                )),
                Ok(Err(e)) => ToolOutcome::text(format!("open_file failed for {raw}: {e}")),
                Err(e) => ToolOutcome::text(format!("Error: open_file task failed: {e}")),
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
    use super::super::permission::SandboxPolicy;

    fn openai_names(caps: &ToolCaps, sandbox: SandboxPolicy) -> Vec<String> {
        openai_tool_specs(caps, sandbox)
            .iter()
            .map(|s| s["function"]["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn openai_spec_lists_safe_tools() {
        let names = openai_names(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
        assert!(names.contains(&WEB_SEARCH.to_string()));
        assert!(names.contains(&GENERATE_FILE.to_string()));
        assert!(names.contains(&FETCH_URL.to_string()));
        assert!(!names.contains(&RUN_CODE.to_string()));
        let specs = openai_tool_specs(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
        assert_eq!(specs[0]["type"], "function");
        assert!(specs[0]["function"]["parameters"]["properties"]["query"].is_object());
    }

    #[test]
    fn generate_diagram_listed_as_safe_tool() {
        assert!(
            openai_names(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite)
                .contains(&GENERATE_DIAGRAM.to_string())
        );
        let a = anthropic_tool_specs(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
        assert!(a.iter().any(|s| s["name"] == GENERATE_DIAGRAM));
        // The diagram tool must expose filename + html args.
        let binding = openai_tool_specs(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
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
            None,
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
            None,
        ));
        assert!(out.artifact.is_none());
        assert!(out.text.contains("requires non-empty"));
    }


    #[test]
    fn browser_read_is_listed_in_openai_spec_with_parameters() {
        let specs = openai_tool_specs(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
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
        let specs = anthropic_tool_specs(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
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
        // by sandbox) and must appear in both provider specs.
        for sandbox in [SandboxPolicy::WorkspaceWrite, SandboxPolicy::ReadOnly] {
            let o = openai_names(&ToolCaps::default(), sandbox);
            assert!(o.contains(&ADD_SOURCE_NOTE.to_string()), "openai {sandbox:?}: add_source_note missing");
            assert!(o.contains(&GET_SOURCE_LEDGER.to_string()));
            assert!(o.contains(&RESET_SOURCE_LEDGER.to_string()));
            let a = anthropic_tool_specs(&ToolCaps::default(), sandbox);
            let an: Vec<&str> = a.iter().map(|s| s["name"].as_str().unwrap()).collect();
            assert!(an.contains(&ADD_SOURCE_NOTE));
            assert!(an.contains(&GET_SOURCE_LEDGER));
            assert!(an.contains(&RESET_SOURCE_LEDGER));
        }
    }


    #[test]
    fn run_code_gated_behind_capability() {
        assert!(!openai_names(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite).contains(&RUN_CODE.to_string()));
        assert!(openai_names(&ToolCaps { code_exec: true, ..Default::default() }, SandboxPolicy::WorkspaceWrite).contains(&RUN_CODE.to_string()));
    }

    #[test]
    fn search_docs_gated_behind_local_docs_capability() {
        // Off by default (no corpus indexed / no sidecar).
        let off = ToolCaps::default();
        assert!(!openai_names(&off, SandboxPolicy::WorkspaceWrite).contains(&SEARCH_DOCS.to_string()));
        assert!(
            !anthropic_tool_specs(&off, SandboxPolicy::WorkspaceWrite)
                .iter()
                .any(|s| s["name"] == SEARCH_DOCS)
        );
        // On when the local-docs capability is set.
        let on = ToolCaps { local_docs: true, ..Default::default() };
        assert!(openai_names(&on, SandboxPolicy::WorkspaceWrite).contains(&SEARCH_DOCS.to_string()));
        assert!(
            anthropic_tool_specs(&on, SandboxPolicy::WorkspaceWrite)
                .iter()
                .any(|s| s["name"] == SEARCH_DOCS)
        );
        // The spec requires query and exposes top_k.
        let spec_value = openai_tool_specs(&on, SandboxPolicy::WorkspaceWrite);
        let spec = spec_value
            .iter()
            .find(|s| s["function"]["name"] == SEARCH_DOCS)
            .and_then(|s| s["function"]["parameters"].as_object())
            .expect("search_docs spec present when enabled");
        assert!(spec["required"].as_array().unwrap().contains(&json!("query")));
        assert!(spec["properties"]["top_k"]["maximum"] == 20);
    }

    #[test]
    fn open_url_listed_as_safe_tool() {
        assert!(openai_names(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite).contains(&OPEN_URL.to_string()));
    }

    #[test]
    fn open_file_listed_for_both_providers_and_stripped_read_only() {
        // Present for both wire formats whenever mutating tools run…
        let openai = openai_names(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
        assert!(openai.contains(&OPEN_FILE.to_string()));
        let anthropic: Vec<String> = anthropic_tool_specs(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite)
            .iter()
            .map(|s| s["name"].as_str().unwrap().to_string())
            .collect();
        assert!(anthropic.contains(&OPEN_FILE.to_string()));
        // …and absent from the schema entirely under read_only, so the model
        // can't even attempt it there.
        assert!(!openai_names(&ToolCaps::default(), SandboxPolicy::ReadOnly)
            .contains(&OPEN_FILE.to_string()));
    }

    #[test]
    fn open_file_rejects_relative_and_missing_paths_without_launching() {
        let client = reqwest::Client::new();
        let dir = std::env::temp_dir();
        // Relative path → guidance error, no launch attempt.
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            &ToolCaps::default(),
            OPEN_FILE,
            &json!({ "path": "traffic.mmd" }),
            None,
        ));
        assert!(out.text.contains("ABSOLUTE"));
        // Absolute but non-existent → not-found error, no launch attempt.
        let gone = std::env::temp_dir().join("definitely-not-here-9f3a2.mmd");
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &dir,
            &ToolCaps::default(),
            OPEN_FILE,
            &json!({ "path": gone.to_string_lossy() }),
            None,
        ));
        assert!(out.text.contains("no file exists"));
    }

    #[test]
    fn open_file_routes_previewable_files_to_the_app_panel() {
        let client = reqwest::Client::new();
        let artifacts = std::env::temp_dir();
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("traffic.mmd");
        std::fs::write(&file, "stateDiagram-v2\n[*] --> Red").expect("write");

        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            &artifacts,
            &ToolCaps::default(),
            OPEN_FILE,
            &json!({ "path": file.to_string_lossy() }),
            None,
        ));
        // A .mmd is previewed natively — it must NOT hit the OS handler (the
        // OS just pops an "open with" picker over apps that can't render it).
        assert!(out.preview.is_some(), "previewable ext routes in-app");
        assert!(out.browse_url.is_none());
        assert!(out.text.contains("preview"));
        assert_eq!(out.preview.as_ref().unwrap().filename, "traffic.mmd");
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
            None,
        ));
        assert!(out.browse_url.is_none());
        assert!(out.text.contains("http(s)"));
    }

    #[test]
    fn anthropic_spec_lists_safe_tools() {
        let specs = anthropic_tool_specs(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
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
            None,
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
            None,
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
            None,
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
            None,
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
        let o = openai_names(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
        assert!(o.contains(&LIST_SKILLS.to_string()));
        let a = anthropic_tool_specs(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
        assert!(a.iter().any(|s| s["name"] == LIST_SKILLS));
    }

    // ---- Filesystem tool + permission-mode tests ----

    #[test]
    fn read_only_mode_strips_mutating_fs_tools_from_schema() {
        // The acceptance test: under read_only, write_file/edit_file/delete_file/
        // move_file/copy_file must be ABSENT from the tool schema (schema-level
        // exclusion, not a UI block) — the model literally cannot invoke them.
        let names = openai_names(&ToolCaps::default(), SandboxPolicy::ReadOnly);
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
        let names = openai_names(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
        assert!(names.contains(&WRITE_FILE.to_string()));
        assert!(names.contains(&DELETE_FILE.to_string()));
    }

    #[test]
    fn anthropic_read_only_also_strips_mutating_fs_tools() {
        let specs = anthropic_tool_specs(&ToolCaps::default(), SandboxPolicy::ReadOnly);
        let names: Vec<&str> = specs.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert!(!names.contains(&WRITE_FILE));
        assert!(names.contains(&READ_FILE));
    }

    // ---- system tools (downloads + native shell) ----

    #[test]
    fn system_tools_listed_in_openai_specs() {
        let names = openai_names(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
        assert!(names.contains(&DOWNLOAD_FILE.to_string()));
        assert!(names.contains(&DOWNLOAD_PROGRESS.to_string()));
        assert!(names.contains(&RUN_SHELL.to_string()));
        assert!(names.contains(&GET_TASK_STATUS.to_string()));
        assert!(names.contains(&CANCEL_TASK.to_string()));
        // The download tool must expose url + dest_path args.
        let specs = openai_tool_specs(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
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
        let specs = anthropic_tool_specs(&ToolCaps::default(), SandboxPolicy::WorkspaceWrite);
        let names: Vec<&str> = specs.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert!(names.contains(&DOWNLOAD_FILE));
        assert!(names.contains(&RUN_SHELL));
        assert!(names.contains(&CANCEL_TASK));
    }

    #[test]
    fn read_only_strips_mutating_system_tools_but_keeps_tracking() {
        // read_only must drop download_file + run_shell from the schema
        // (like write_file) while keeping the read-only tracking tools.
        let names = openai_names(&ToolCaps::default(), SandboxPolicy::ReadOnly);
        assert!(!names.contains(&DOWNLOAD_FILE.to_string()), "download_file must be absent under read_only");
        assert!(!names.contains(&RUN_SHELL.to_string()), "run_shell must be absent under read_only");
        assert!(names.contains(&DOWNLOAD_PROGRESS.to_string()));
        assert!(names.contains(&GET_TASK_STATUS.to_string()));
        assert!(names.contains(&CANCEL_TASK.to_string()));
    }

}
