//! Chat mode — direct LLM HTTP API streaming (separate from CLI agent panes).
//!
//! Four providers: Anthropic, OpenAI, AnthropicCompatible, OpenAICompatible.
//! All SSE streaming, API keys stored in the OS keychain, HTTP in Rust backend.

pub mod artifacts;
pub mod codeexec;
pub mod commands;
pub mod office;
pub mod providers;
pub mod pygen;
pub mod tools;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// Max model⇄tool round-trips in a single tool-enabled turn before we stop,
/// to bound cost and prevent runaway loops.
const MAX_TOOL_ITERS: usize = 15;

/// Built-in guidance appended to every tool-enabled turn so the model knows how
/// to produce high-quality artifacts. The user's custom system prompt and
/// skills are layered on top of this (never replacing it).
const TOOL_GUIDE: &str = "You are Conduit, a local-first desktop assistant with tools. \
When the user asks for a document, report, spreadsheet or slide deck, call \
`generate_document` and WRITE PYTHON that builds a genuinely professional file \
(python-docx for docx, python-pptx for pptx, openpyxl for xlsx, reportlab for \
pdf). Design it properly: a clear title/cover, consistent typography and \
heading hierarchy, a tasteful colour palette, tables where useful, real \
multi-slide layouts for decks, and page numbers/footers where appropriate — \
never a plain text dump. Save the file to the path in the CONDUIT_OUTPUT \
environment variable. Only use `generate_file` for plain text formats (txt, md, \
csv, json, html). Prefer accurate, well-structured content over filler.";

/// Coarse classification of the active model. Frontier hosted models (Claude,
/// GPT, etc.) follow implied instructions reliably; locally-run or
/// small-context models do not, so they get the STRICT addendum that repeats
/// the highest-risk rules explicitly. The prompt assembled for a turn must
/// match what the live tool registry actually exposes — see `tools.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelClass {
    /// Large hosted models served via an API (Claude, GPT, etc.). Lighter
    /// instruction is sufficient; the BASE prompt alone applies.
    Frontier,
    /// Locally-run or small-context models. Gets the STRICT addendum appended
    /// after BASE, because this app cannot afford silent tool-use failures.
    Local,
}

/// Heuristic mapping from a model id string to its class. Known local/smaller
/// open-weight families are classified `Local`; everything else (including
/// unknown hosted models) defaults to `Frontier`. Extend this match list as
/// new local runtimes are wired in — the default must stay optimistic for
/// hosted models so they aren't burdened with the STRICT repeat.
pub fn classify_model(model: &str) -> ModelClass {
    let m = model.to_ascii_lowercase();
    let local_markers = [
        "llama", "qwen", "phi-", "phi3", "gemma", "mistral-7b", "mixtral",
        "deepseek-r1", "deepseek-coder", "yi-", "starcoder", "codegemma",
        "stablelm", "falcon", "orca", "vicuna", "wizardlm", " neural",
        "local", "ollama",
    ];
    if local_markers.iter().any(|tok| m.contains(tok)) {
        ModelClass::Local
    } else {
        ModelClass::Frontier
    }
}

/// The CORE system prompt — the source-code layer, versioned with app
/// releases and never user-editable. Concatenated FIRST, before the user's
/// custom prompt (Settings → Assistant) and before any conditionally-loaded
/// skills. Tool names and the artifact mechanism below must stay in sync with
/// the live tool registry in `tools.rs` (`WEB_SEARCH`, `GENERATE_DOCUMENT`,
/// `GENERATE_FILE`, `FETCH_URL`, `OPEN_URL`, `RUN_CODE`).
fn core_prompt_base() -> &'static str {
    "You are running inside Conduit, a desktop application, in the Chat tab. \
You are a general assistant, separate from Conduit's Dev tab coding agent panes \
(which run Claude Code / Kimi Code directly against real project repositories — \
you do not have that access here).\n\n\
## Tool contract\n\
You have access to some or all of the following tools, depending on the active \
provider's capabilities. Only call a tool if it is present in your actual tool \
list for this turn — never assume a tool exists because it is described here.\n\n\
- `web_search(query)` — returns search results. May be a native provider tool \
or an injected fallback (Tavily). Call it the same way regardless of which \
backend serves it.\n\
- `generate_document(format, instructions)` — writes Python (python-docx, \
python-pptx, openpyxl or reportlab) that builds a real, professionally \
formatted file and saves it to the CONDUIT_OUTPUT path. Use for docx/pptx/xlsx/pdf. \
Producing the file also surfaces it as a downloadable artifact in the panel.\n\
- `generate_file(filename, content)` — for plain text formats (txt, md, csv, \
json, html). Also surfaces the file as an artifact.\n\
- `generate_diagram(filename, title, html)` — the tool for EVERY diagram \
(architecture, flowchart, sequence, feature breakdown, mind-map, anything \
visual). Author it as ONE root inline <svg> (with xmlns, viewBox and \
width/height): nodes as <rect rx=..>, labels as <text>, connectors as \
<path>/<line> with an arrowhead <marker>. This is true vector, so it exports \
crisply to SVG and PNG. Produces a self-contained .html file surfaced as a \
diagram artifact.\n\
- `fetch_url(url)` — fetch a specific page's readable text by URL.\n\
- `open_url(url)` — open a page in the app's built-in browser pane and return \
its text.\n\
- `browser_read()` — inspect the page currently open in the browser pane: its \
URL, title, visible text, and a numbered list of interactive elements (each \
with a `ref`).\n\
- `browser_click(ref)` / `browser_type(ref, text)` / `browser_scroll(amount)` — \
drive that page: click a link/button, type into an input, or scroll. Refs come \
from the latest `browser_read`.\n\
- `run_code(language, code)` — execute a short snippet (python/javascript/bash) \
in a sandbox. Only present when code execution is explicitly enabled for this chat.\n\n\
If a tool described here is not actually available in a given turn, do not \
claim to have used it. State the limitation plainly (e.g. \"the active model \
doesn't have search available — this answer isn't verified against current \
information\").\n\n\
## Artifact-panel protocol\n\
- For docx/pptx/xlsx/pdf and plain-text files, produce the file via \
`generate_document` or `generate_file`; the file is surfaced to the artifact \
panel automatically — there is no separate \"emit artifact\" tool to call.\n\
- For Markdown/SVG/HTML meant to be read in-app, put it directly in your \
text response (the frontend renders fenced blocks) rather than inventing a tool \
call for it.\n\
- Diagrams (flowcharts, sequence, state, class, ER, gantt, mindmaps, etc.): \
ALWAYS call `generate_diagram` and author the diagram as inline <svg> — the app \
surfaces it in the artifact panel as a real, exportable vector diagram. \
Whenever you decide a diagram would help explain something, or the user asks \
you to diagram/visualize it, call `generate_diagram`. Do NOT emit ```mermaid \
blocks (Mermaid is not used here), never describe a diagram in prose without \
producing it, and never draw it with ASCII art.\n\
- Do not narrate the artifact's contents at length after producing it — a short \
one-line acknowledgment is enough; the panel is the primary surface.\n\n\
## Browsing the web interactively\n\
When the user asks you to *do* something on a site (search on it, follow a \
link, fill a form, read further down a page), drive the built-in browser in an \
observe→act loop: (1) `open_url` to load the starting page; (2) `browser_read` \
to see the current URL, text and the numbered interactive elements; (3) act \
with `browser_click`/`browser_type`/`browser_scroll` using a `ref` from that \
read; (4) `browser_read` again to observe the result, and repeat until the goal \
is met. The `ref` numbers are only valid for the most recent read — always \
re-read after the page changes. Prefer `open_url`/`browser_read` (which return \
page text) over `fetch_url` when the user should also *see* the page. If an \
action reports an error or a page won't load, say so plainly rather than \
pretending it worked.\n\n\
## Skill loading\n\
Skill files (docx, pptx, pdf, diagram-html-svg, and any user-added skills from \
Settings → Assistant) are user-enabled instructions. When a skill is enabled, \
its content is appended to your context on every turn — they are not loaded \
conditionally. Use a skill's guidance only when it applies to the current \
request; its instructions take precedence over your general knowledge of that \
library/format, since it encodes known failure modes and house style the \
general knowledge doesn't.\n\n\
## Scope boundary\n\
You do not have access to the user's local project directories, git state, or \
filesystem outside the sandbox's scratch directory. If a request is clearly a \
coding/project task against a real repository, say plainly that it belongs in \
the Dev tab, rather than attempting it without the necessary access or \
fabricating a plausible-looking response.\n\n\
## Session isolation\n\
You do not have memory of the user's other Conduit sessions (other Chat \
conversations, or Dev tab sessions) unless their content has been explicitly \
pasted or referenced in this conversation. Do not assume continuity you don't \
actually have context for."
}

/// STRICT addendum — appended only when `ModelClass == Local`. Restates the
/// rules above more explicitly and repeats the highest-risk ones, because
/// smaller/local models follow implied instructions less reliably than
/// frontier models and this app cannot afford silent tool-use failures.
fn core_prompt_strict() -> &'static str {
    "\n\n## STRICT ADDENDUM (local/small-context model)\n\
The rules above are restated more explicitly here, because you are running on a \
smaller/local model that follows implied instructions less reliably.\n\n\
1. Before answering, check: does this request need a tool? If it needs current \
information, current prices, or anything you cannot know with certainty from \
training alone, you MUST call `web_search` before answering, if it is \
available. Do not answer from memory and imply it is current.\n\
2. Before generating any document/deck/PDF, you MUST call `generate_document` \
(or `generate_file` for plain text), produce an actual file, and let it surface \
as an artifact. Describing what the file would contain, without calling these \
tools, is an incorrect response — treat it as a failed turn, not a shortcut.\n\
3. The tool names are EXACTLY: `web_search`, `generate_document`, \
`generate_file`, `generate_diagram`, `fetch_url`, `open_url`, `browser_read`, \
`browser_click`, `browser_type`, `browser_scroll`, `run_code`. Do not call \
`execute_code`, `emit_artifact`, or any other name — those do not exist here.\n\
4. If a tool call fails or is unavailable, say so in one plain sentence. Do \
not continue as if it had succeeded.\n\
5. Keep tool-call arguments minimal and matching the schema in your tool list — \
do not invent additional parameters.\n\
6. If your available tool-calling format cannot express a call, fall back to a \
single fenced code block labeled `tool_call` containing a JSON object with \
`tool` and `arguments` keys — the app will parse this fallback format."
}

/// Build the CORE system prompt for a given provider/model class. Always
/// included; concatenated before the user's custom prompt and any skills.
/// `model` is the raw model id (used only to classify Frontier vs Local);
/// `provider` is reserved for future provider-specific tweaks but currently
/// does not vary the base text.
pub fn core_prompt_for(provider: ChatProviderId, model: &str) -> String {
    let _ = provider; // reserved: no provider-specific branching yet
    let base = core_prompt_base();
    match classify_model(model) {
        ModelClass::Frontier => base.to_string(),
        ModelClass::Local => format!("{}{}", base, core_prompt_strict()),
    }
}

/// Assemble the effective system prompt from the built-in CORE prompt (always
/// included, provider/model-aware), the built-in tool guidance (only when
/// tools are on), the user's custom system prompt, and any enabled skills.
/// Returns `None` when nothing applies.
pub fn build_system_prompt(
    provider: ChatProviderId,
    model: &str,
    custom: Option<&str>,
    skills: &[(String, String)],
    tools_enabled: bool,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    parts.push(core_prompt_for(provider, model));
    if tools_enabled {
        parts.push(TOOL_GUIDE.to_string());
    }
    if let Some(c) = custom {
        let c = c.trim();
        if !c.is_empty() {
            parts.push(c.to_string());
        }
    }
    if !skills.is_empty() {
        let mut s = String::from(
            "The user has provided the following reusable skills. Apply the \
             relevant ones when they fit the request:\n",
        );
        for (name, body) in skills {
            let body = body.trim();
            if body.is_empty() {
                continue;
            }
            s.push_str(&format!("\n## Skill: {}\n{}\n", name.trim(), body));
        }
        parts.push(s);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

use crate::db;
use crate::types::*;
use providers::*;

/// Manages active chat streams. Each chat_session_id maps to a cancellation
/// token (tokio AbortHandle). Only one stream per session is allowed — sending
/// a new message cancels the previous one automatically.
pub struct ChatManager {
    pub client: reqwest::Client,
    streams: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl ChatManager {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            streams: Mutex::new(HashMap::new()),
        }
    }

    /// Send a chat message. Spawns a tokio task that:
    /// 1. Builds the provider HTTP request
    /// 2. Reads SSE chunks, emitting `chat:token` events
    /// 3. On completion, emits `chat:done` and persists the assistant message
    /// 4. On error, emits `chat:error`
    ///
    /// The user message is assumed already persisted by the caller (commands layer).
    /// Cancelling any existing stream for this session first.
    pub fn send(
        &self,
        chat_session_id: String,
        provider_id: ChatProviderId,
        model: String,
        api_key: String,
        base_url: Option<String>,
        effort: Option<String>,
        tools_enabled: bool,
        code_exec_enabled: bool,
        system: Option<String>,
        messages: Vec<ChatMessage>,
        db: Arc<Mutex<Connection>>,
        app: AppHandle,
    ) {
        // Cancel any existing stream for this session.
        self.cancel(&chat_session_id);

        let provider = resolve_provider(&provider_id);
        let chat_req = ChatRequest {
            model,
            messages,
            max_tokens: Some(4096),
            system: system.filter(|s| !s.trim().is_empty()),
            effort,
        };

        let is_openai = matches!(
            provider_id,
            ChatProviderId::OpenAI | ChatProviderId::OpenAICompatible
        );
        let is_anthropic = matches!(
            provider_id,
            ChatProviderId::Anthropic | ChatProviderId::AnthropicCompatible
        );
        // Tools need a base URL; compatible providers already carry one, native
        // providers fall back to their default endpoint.
        let tool_base = base_url.clone().unwrap_or_else(|| {
            if is_openai {
                OpenAIProvider::DEFAULT_BASE.to_string()
            } else {
                AnthropicProvider::DEFAULT_BASE.to_string()
            }
        });

        let client = self.client.clone();
        let sid = chat_session_id.clone();
        let caps = tools::ToolCaps {
            code_exec: code_exec_enabled,
        };

        let handle = tokio::spawn(async move {
            let result = if tools_enabled && is_openai {
                run_openai_tool_loop(&client, &tool_base, &api_key, &chat_req, caps, &sid, &app).await
            } else if tools_enabled && is_anthropic {
                run_anthropic_tool_loop(&client, &tool_base, &api_key, &chat_req, caps, &sid, &app)
                    .await
            } else {
                run_chat_stream(
                    &client,
                    provider.as_ref(),
                    &sid,
                    &chat_req,
                    &api_key,
                    base_url.as_deref(),
                    &app,
                )
                .await
            };

            match result {
                Ok((full_response, usage)) => {
                    // Persist the assistant message with usage.
                    {
                        let conn = db.lock();
                        let _ = db::add_chat_message(
                            &conn,
                            &sid,
                            "assistant",
                            &full_response,
                            usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.input_tokens)
                                } else {
                                    None
                                }
                            }),
                            usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.output_tokens)
                                } else {
                                    None
                                }
                            }),
                            usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.cost_usd)
                                } else {
                                    None
                                }
                            }),
                        );
                        let _ = db::touch_chat_session(&conn, &sid);
                    }
                    let _ = app.emit(
                        "chat:done",
                        ChatDonePayload {
                            chat_session_id: sid.clone(),
                            input_tokens: usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.input_tokens)
                                } else {
                                    None
                                }
                            }),
                            output_tokens: usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.output_tokens)
                                } else {
                                    None
                                }
                            }),
                            cost_usd: usage.as_ref().and_then(|u| {
                                if u.input_tokens > 0 || u.output_tokens > 0 {
                                    Some(u.cost_usd)
                                } else {
                                    None
                                }
                            }),
                        },
                    );
                }
                Err(e) => {
                    let _ = app.emit(
                        "chat:error",
                        ChatErrorPayload {
                            chat_session_id: sid.clone(),
                            message: e,
                            code: None,
                        },
                    );
                }
            }
        });

        self.streams
            .lock()
            .insert(chat_session_id.clone(), handle.abort_handle());
    }

    /// Cancel an active stream for the given session (no-op if none active).
    pub fn cancel(&self, chat_session_id: &str) {
        if let Some(handle) = self.streams.lock().remove(chat_session_id) {
            handle.abort();
        }
    }

    /// App-exit cleanup: cancel all active streams.
    pub fn cancel_all(&self) {
        let handles: Vec<_> = self.streams.lock().drain().map(|(_, h)| h).collect();
        for handle in handles {
            handle.abort();
        }
    }
}

/// Runs the full SSE stream lifecycle for one chat request.
/// Returns the accumulated assistant text and optional usage info.
async fn run_chat_stream(
    client: &reqwest::Client,
    provider: &dyn ChatProvider,
    chat_session_id: &str,
    req: &ChatRequest,
    api_key: &str,
    base_url: Option<&str>,
    app: &AppHandle,
) -> Result<(String, Option<ChatUsage>), String> {
    let request = provider
        .build_request(client, req, api_key, base_url)
        .map_err(|e| format!("failed to build request: {e}"))?;

    let response = request
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }

    use futures_util::StreamExt;

    let mut stream = response.bytes_stream();
    let mut buf = String::new(); // SSE buffer passed to provider parser
    let mut full_text = String::new();
    let mut in_think = false;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("stream read error: {e}"))?;
        let text = String::from_utf8_lossy(&chunk);

        for line in text.lines() {
            match provider.parse_sse_chunk(line, &mut buf)? {
                (Some(token), false) => {
                    // Reasoning tokens are sentinel-prefixed by the parser;
                    // wrap contiguous runs in <think>…</think> so the UI can
                    // render a collapsible thinking block.
                    let mut out = String::new();
                    if let Some(reasoning) = token.strip_prefix(REASONING_PREFIX) {
                        if !in_think {
                            out.push_str("<think>");
                            in_think = true;
                        }
                        out.push_str(reasoning);
                    } else {
                        if in_think {
                            out.push_str("</think>");
                            in_think = false;
                        }
                        out.push_str(&token);
                    }
                    full_text.push_str(&out);
                    let _ = app.emit(
                        "chat:token",
                        ChatTokenPayload {
                            chat_session_id: chat_session_id.to_string(),
                            token: out,
                        },
                    );
                }
                (_, true) => {
                    // Stream done — usage will be parsed from buffer below.
                    break;
                }
                _ => {}
            }
        }
    }

    if in_think {
        full_text.push_str("</think>");
        let _ = app.emit(
            "chat:token",
            ChatTokenPayload {
                chat_session_id: chat_session_id.to_string(),
                token: "</think>".to_string(),
            },
        );
    }

    let usage = provider.parse_usage(&buf);
    Ok((full_text, usage))
}

/// Emit one `chat:token` event and append it to the running transcript so the
/// persisted assistant message ends up identical to what was streamed.
fn emit_token(app: &AppHandle, sid: &str, token: &str, full: &mut String) {
    if token.is_empty() {
        return;
    }
    full.push_str(token);
    let _ = app.emit(
        "chat:token",
        ChatTokenPayload {
            chat_session_id: sid.to_string(),
            token: token.to_string(),
        },
    );
}

/// Directory where generated artifacts are written (`<Documents>/Conduit`,
/// falling back to home, then temp). Created on demand by the artifact writer.
fn artifacts_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("Conduit")
}

/// Run a tool and, if it produced a file, notify the UI. Returns the text to
/// feed back to the model.
async fn run_tool(
    client: &reqwest::Client,
    artifacts_dir: &std::path::Path,
    caps: tools::ToolCaps,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> String {
    // Agentic browser tools act on the live browser-pane webview, so they run
    // here (where the AppHandle -> BrowserState is available) rather than in
    // the provider-agnostic execute_tool dispatcher.
    if let Some(text) = run_browser_tool(app, name, args).await {
        return text;
    }
    let outcome = tools::execute_tool(client, artifacts_dir, caps, name, args).await;
    if let Some(a) = outcome.artifact {
        let _ = app.emit(
            "chat:artifact",
            ChatArtifactPayload {
                chat_session_id: sid.to_string(),
                path: a.path,
                filename: a.filename,
            },
        );
    }
    if let Some(url) = outcome.browse_url {
        let _ = app.emit(
            "chat:open-browser",
            ChatOpenBrowserPayload {
                chat_session_id: sid.to_string(),
                url,
            },
        );
    }
    outcome.text
}

/// Dispatch the agentic browser tools (`browser_read`/`browser_click`/
/// `browser_type`/`browser_scroll`) against the active browser-pane webview.
/// Returns `None` for any other tool name so the caller falls through to the
/// normal tool dispatcher.
async fn run_browser_tool(app: &AppHandle, name: &str, args: &Value) -> Option<String> {
    use tools::{BROWSER_CLICK, BROWSER_READ, BROWSER_SCROLL, BROWSER_TYPE};
    if !matches!(name, BROWSER_READ | BROWSER_CLICK | BROWSER_TYPE | BROWSER_SCROLL) {
        return None;
    }
    let browser = app.state::<crate::BrowserState>();
    let mgr = browser.0.clone();
    let result = match name {
        BROWSER_READ => mgr.read_page().await,
        BROWSER_CLICK => match args.get("ref").and_then(|v| v.as_i64()) {
            Some(r) => mgr.click_ref(r).await,
            None => Err("browser_click requires an integer \"ref\" from browser_read.".to_string()),
        },
        BROWSER_TYPE => {
            let r = args.get("ref").and_then(|v| v.as_i64());
            let text = args.get("text").and_then(|v| v.as_str());
            match (r, text) {
                (Some(r), Some(text)) => mgr.type_into(r, text).await,
                _ => Err("browser_type requires an integer \"ref\" and \"text\".".to_string()),
            }
        }
        BROWSER_SCROLL => {
            let dy = args.get("amount").and_then(|v| v.as_i64()).unwrap_or(600);
            mgr.scroll_by(dy).await
        }
        _ => unreachable!("guarded by matches! above"),
    };
    Some(match result {
        Ok(text) => text,
        Err(e) => format!("{name} failed: {e}"),
    })
}

/// Monotonic counter for synthetic tool-call ids. Real OpenAI ids come from
/// the server; when we synthesize calls from Hermes text we still need a
/// unique id so the echoed assistant message and the matching `tool` result
/// can be paired correctly on the next request.
fn next_synthetic_tool_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("call_synth_{n}")
}

/// Parse the `arguments` string of an OpenAI-style tool call into a JSON
/// object. Some providers emit malformed payloads — e.g. a stray empty object
/// prepended (`"{}{\"query\":\"x\"}"`) or several concatenated objects. We read
/// every JSON value in the string and merge object fields (later keys win) so a
/// leading `{}` no longer wipes out the real arguments.
fn parse_tool_args(s: &str) -> Value {
    let s = s.trim();
    if s.is_empty() {
        return json!({});
    }
    // Fast path: a single well-formed object.
    if let Ok(v @ Value::Object(_)) = serde_json::from_str::<Value>(s) {
        return v;
    }
    let mut merged = serde_json::Map::new();
    let stream = serde_json::Deserializer::from_str(s).into_iter::<Value>();
    for item in stream {
        if let Ok(Value::Object(map)) = item {
            for (k, v) in map {
                merged.insert(k, v);
            }
        }
    }
    Value::Object(merged)
}

/// Some OpenAI-compatible servers (and several Qwen / DeepSeek / MiMo
/// fine-tunes served through `ai2.18.show`-style aggregators) do not translate
/// the OpenAI `tools` field into the model's native tool template. Instead of
/// populating `choices[0].message.tool_calls`, the model emits its trained
/// **Hermes-format** tool call as plain text inside `content`:
///
/// ```text
/// <tool_calls>
/// <invoke name="web_search">
/// <parameter name="query" type="string">cow</parameter>
/// </invoke>
/// </tool_calls>
/// ```
///
/// This parser recovers those calls so the existing tool loop can execute
/// them. It returns the list of `(tool_name, arguments)` pairs found, or
/// `None` when the content carries no recognizable tool block. The sibling
/// [`strip_hermes_tool_calls`] removes the raw markup so the user never sees
/// the XML in the rendered message.
fn parse_hermes_tool_calls(content: &str) -> Option<Vec<(String, Value)>> {
    // Locate the outer block. Tolerate models that omit the closing tag by
    // parsing from `<tool_calls>` to end-of-string.
    let start_idx = content.find("<tool_calls>")?;
    let after_open = &content[start_idx + "<tool_calls>".len()..];
    let block = match after_open.find("</tool_calls>") {
        Some(end) => &after_open[..end],
        None => after_open,
    };
    if block.trim().is_empty() {
        return None;
    }

    // The known shape is a series of `<invoke name="…">…</invoke>` regions,
    // each holding `<parameter name="…" [type="…"]>value</parameter>` entries.
    let mut calls: Vec<(String, Value)> = Vec::new();
    let mut rest = block;
    while let Some(inv) = rest.find("<invoke") {
        rest = &rest[inv + "<invoke".len()..];
        let body_end = rest.find("</invoke>").unwrap_or(rest.len());
        let tag_and_body = &rest[..body_end];
        rest = &rest[body_end..];

        // The opening `<invoke …>` tag runs up to the first `>`; the invoke
        // name lives in that slice (not in the parameter body that follows).
        let invoke_open = match tag_and_body.find('>') {
            Some(g) => &tag_and_body[..g],
            None => "",
        };
        let name = extract_quoted_attr(invoke_open, "name").unwrap_or_default();
        // The body starts after the opening `<invoke …>` tag's closing `>`.
        let body = match tag_and_body.find('>') {
            Some(g) => &tag_and_body[g + 1..],
            None => "",
        };

        let mut args = serde_json::Map::new();
        let mut pbody = body;
        while let Some(p) = pbody.find("<parameter") {
            pbody = &pbody[p + "<parameter".len()..];
            let tag_end = match pbody.find('>') {
                Some(g) => g + 1,
                None => break,
            };
            let opening = &pbody[..tag_end - 1]; // text before the closing `>`
            let pname = extract_quoted_attr(opening, "name").unwrap_or_default();
            let val_end = pbody[tag_end..]
                .find("</parameter>")
                .map(|e| tag_end + e)
                .unwrap_or(pbody.len());
            let raw = pbody[tag_end..val_end].trim();
            if !pname.is_empty() {
                args.insert(pname.to_string(), coerce_param_value(raw));
            }
            pbody = &pbody[val_end..];
        }

        if !name.is_empty() {
            calls.push((name, Value::Object(args)));
        }
    }

    if calls.is_empty() {
        None
    } else {
        Some(calls)
    }
}

/// Extract the value of a `name="value"` (or `'value'`) attribute from the
/// opening tag text. Returns the unquoted value, or `None` if the attribute
/// isn't present.
fn extract_quoted_attr(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=");
    let at = tag.find(&needle)?;
    let after = tag[at + needle.len()..].trim_start();
    let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let inner = &after[quote.len_utf8()..];
    let end = inner.find(quote)?;
    Some(inner[..end].to_string())
}

/// Remove every `<tool_calls>…</tool_calls>` region (and the alternative
/// ` ```tool_call … ``` ` / ` ```tool_calls … ``` ` fenced variant) from a
/// message so the raw markup is never shown to the user or re-sent as history.
/// A dangling `<tool_calls>` with no close (the model kept streaming) is also
/// trimmed from that point onward.
fn strip_hermes_tool_calls(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("<tool_calls>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</tool_calls>") {
            Some(end) => rest = &rest[start + end + "</tool_calls>".len()..],
            None => {
                // Unclosed block — drop the trailing remainder.
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// Coerce a raw parameter string (the text between `<parameter>…</parameter>`)
/// into a JSON value. Bare scalars that parse as bool/int/float/null are typed
/// accordingly; JSON-looking values are parsed; everything else stays a string.
fn coerce_param_value(raw: &str) -> Value {
    let s = raw.trim();
    if s.is_empty() {
        return Value::Null;
    }
    match s {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        "null" => return Value::Null,
        _ => {}
    }
    if let Ok(n) = s.parse::<i64>() {
        return Value::from(n);
    }
    if let Ok(f) = s.parse::<f64>() {
        return json!(f);
    }
    if (s.starts_with('{') || s.starts_with('[')) {
        if let Ok(v) = serde_json::from_str::<Value>(s) {
            return v;
        }
    }
    Value::String(s.to_string())
}

/// Human-readable narration of a tool call, shown (inside the `<think>` block)
/// while the tool runs.
fn tool_status_line(name: &str, args: &Value) -> String {
    if name == tools::WEB_SEARCH {
        let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
        format!("Searching the web for \"{q}\"…\n")
    } else if name == tools::GENERATE_FILE {
        let f = args.get("filename").and_then(|v| v.as_str()).unwrap_or("file");
        let fmt = args.get("format").and_then(|v| v.as_str()).unwrap_or("");
        format!("Generating {fmt} file \"{f}\"…\n")
    } else if name == tools::GENERATE_DOCUMENT {
        let f = args.get("filename").and_then(|v| v.as_str()).unwrap_or("document");
        let fmt = args.get("format").and_then(|v| v.as_str()).unwrap_or("");
        format!("Building {fmt} document \"{f}\"…\n")
    } else if name == tools::FETCH_URL || name == tools::OPEN_URL {
        let u = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let verb = if name == tools::OPEN_URL { "Opening" } else { "Reading" };
        format!("{verb} {u}…\n")
    } else if name == tools::RUN_CODE {
        let lang = args.get("language").and_then(|v| v.as_str()).unwrap_or("code");
        format!("Running {lang} code…\n")
    } else if name == tools::BROWSER_READ {
        "Reading the browser page…\n".to_string()
    } else if name == tools::BROWSER_CLICK {
        let r = args.get("ref").and_then(|v| v.as_i64()).unwrap_or(-1);
        format!("Clicking element [{r}] in the browser…\n")
    } else if name == tools::BROWSER_TYPE {
        let t = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
        format!("Typing \"{t}\" in the browser…\n")
    } else if name == tools::BROWSER_SCROLL {
        "Scrolling the browser page…\n".to_string()
    } else {
        format!("Running tool {name}…\n")
    }
}

/// Build an OpenAI-style message object, using a multimodal `content` array
/// when the message carries images (vision), otherwise a plain string.
fn openai_message_json(m: &ChatMessage) -> Value {
    if m.images.is_empty() {
        return json!({ "role": m.role, "content": m.content });
    }
    let mut parts: Vec<Value> = Vec::new();
    if !m.content.is_empty() {
        parts.push(json!({ "type": "text", "text": m.content }));
    }
    for img in &m.images {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", img.media_type, img.data) }
        }));
    }
    json!({ "role": m.role, "content": parts })
}

/// Build an Anthropic-style message object, using a content-block array with
/// `image` blocks when the message carries images, otherwise a plain string.
fn anthropic_message_json(m: &ChatMessage) -> Value {
    if m.images.is_empty() {
        return json!({ "role": m.role, "content": m.content });
    }
    let mut blocks: Vec<Value> = Vec::new();
    if !m.content.is_empty() {
        blocks.push(json!({ "type": "text", "text": m.content }));
    }
    for img in &m.images {
        blocks.push(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": img.media_type,
                "data": img.data,
            }
        }));
    }
    json!({ "role": m.role, "content": blocks })
}

/// Agentic tool loop for OpenAI-style providers (native + compatible).
///
/// Uses non-streaming `/v1/chat/completions` calls: request with `tools`, and
/// if the model responds with `tool_calls`, run each tool, feed the results
/// back, and repeat until it produces a final answer (or the iteration cap is
/// hit). Tool narration is wrapped in a `<think>` block so the UI shows it as a
/// collapsible "thought process" and it's stripped from re-sent history.
async fn run_openai_tool_loop(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
    req: &ChatRequest,
    caps: tools::ToolCaps,
    sid: &str,
    app: &AppHandle,
) -> Result<(String, Option<ChatUsage>), String> {
    let url = format!("{base}/v1/chat/completions");
    let tool_specs = tools::openai_tool_specs(caps);
    let art_dir = artifacts_dir(app);

    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = &req.system {
        if !sys.is_empty() {
            messages.push(json!({ "role": "system", "content": sys }));
        }
    }
    for m in &req.messages {
        messages.push(openai_message_json(m));
    }

    let mut full = String::new();
    let mut in_think = false;
    let mut total_in = 0i64;
    let mut total_out = 0i64;
    let mut have_usage = false;

    for _ in 0..MAX_TOOL_ITERS {
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": false,
            "tools": tool_specs,
        });
        if let Some(e) = &req.effort {
            body["reasoning_effort"] = json!(e);
        }

        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {status}: {b}"));
        }

        let v: Value = resp.json().await.map_err(|e| format!("decode failed: {e}"))?;
        if let Some(u) = v.get("usage") {
            total_in += u.get("prompt_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            total_out += u.get("completion_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            have_usage = true;
        }

        let message = v
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .cloned()
            .ok_or_else(|| "response missing choices[0].message".to_string())?;

        let tool_calls = message
            .get("tool_calls")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        // Fallback for servers that don't translate the OpenAI `tools` field
        // into the model's native tool template (common on OpenAI-compatible
        // aggregators serving Qwen / DeepSeek / MiMo fine-tunes). The model
        // then emits its trained Hermes-format tool call as plain text in
        // `content`. Recover those calls and synthesize the same structured
        // shape the loop below already handles, so the tools actually run.
        let tool_calls: Vec<Value> = if tool_calls.is_empty() {
            let content = message.get("content").and_then(|c| c.as_str()).unwrap_or("");
            match parse_hermes_tool_calls(content) {
                Some(parsed) if !parsed.is_empty() => parsed
                    .into_iter()
                    .map(|(name, args)| {
                        let id = next_synthetic_tool_id();
                        json!({
                            "id": id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": args.to_string(),
                            },
                        })
                    })
                    .collect(),
                _ => Vec::new(),
            }
        } else {
            tool_calls
        };

        if !tool_calls.is_empty() {
            if !in_think {
                emit_token(app, sid, "<think>", &mut full);
                in_think = true;
            }
            // The assistant turn (carrying tool_calls) must be echoed back
            // before the matching tool results. Some providers emit malformed
            // `arguments` (e.g. a stray `{}` prefix); we normalize them to clean
            // JSON here so the re-sent history doesn't confuse the model into
            // repeating the same call.
            let mut echoed = message.clone();
            // When the calls were recovered from Hermes text, the message's
            // `content` still holds the raw `<tool_calls>` markup. Strip it so
            // the markup is neither re-sent nor shown to the user downstream.
            if let Some(c) = echoed.get_mut("content").and_then(|c| c.as_str()) {
                let stripped = strip_hermes_tool_calls(c);
                if stripped != c {
                    if let Some(obj) = echoed.as_object_mut() {
                        obj.insert("content".to_string(), Value::String(stripped));
                    }
                }
            }
            if let Some(arr) = echoed
                .get_mut("tool_calls")
                .and_then(|t| t.as_array_mut())
            {
                for tc in arr.iter_mut() {
                    if let Some(a) = tc.get_mut("function").and_then(|f| f.get_mut("arguments")) {
                        let cleaned = a
                            .as_str()
                            .map(parse_tool_args)
                            .unwrap_or_else(|| json!({}));
                        *a = json!(cleaned.to_string());
                    }
                }
            }
            messages.push(echoed);
            for tc in &tool_calls {
                let id = tc.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let name = tc
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let args_str = tc
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("{}");
                let args = parse_tool_args(args_str);

                emit_token(app, sid, &tool_status_line(&name, &args), &mut full);
                let result = run_tool(client, &art_dir, caps, app, sid, &name, &args).await;
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": result,
                }));
            }
            continue;
        }

        // No tool calls → final answer.
        if in_think {
            emit_token(app, sid, "</think>", &mut full);
        }
        let content = message.get("content").and_then(|c| c.as_str()).unwrap_or("");
        // Never surface raw Hermes tool-call markup to the user.
        let content = strip_hermes_tool_calls(content);
        emit_token(app, sid, &content, &mut full);
        return Ok((full, build_usage(true, total_in, total_out, have_usage)));
    }

    if in_think {
        emit_token(app, sid, "</think>", &mut full);
    }
    emit_token(
        app,
        sid,
        "\n\n_Stopped after reaching the tool-call limit._",
        &mut full,
    );
    Ok((full, build_usage(true, total_in, total_out, have_usage)))
}

/// Agentic tool loop for Anthropic-style providers (native + compatible).
async fn run_anthropic_tool_loop(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
    req: &ChatRequest,
    caps: tools::ToolCaps,
    sid: &str,
    app: &AppHandle,
) -> Result<(String, Option<ChatUsage>), String> {
    let url = format!("{base}/v1/messages");
    let tool_specs = tools::anthropic_tool_specs(caps);
    let art_dir = artifacts_dir(app);

    let mut messages: Vec<Value> = req
        .messages
        .iter()
        .map(anthropic_message_json)
        .collect();

    let mut full = String::new();
    let mut in_think = false;
    let mut total_in = 0i64;
    let mut total_out = 0i64;
    let mut have_usage = false;

    for _ in 0..MAX_TOOL_ITERS {
        let mut body = json!({
            "model": req.model,
            "max_tokens": req.max_tokens.unwrap_or(4096),
            "messages": messages,
            "tools": tool_specs,
            "stream": false,
        });
        if let Some(sys) = &req.system {
            if !sys.is_empty() {
                body["system"] = json!(sys);
            }
        }

        let resp = client
            .post(&url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {status}: {b}"));
        }

        let v: Value = resp.json().await.map_err(|e| format!("decode failed: {e}"))?;
        if let Some(u) = v.get("usage") {
            total_in += u.get("input_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            total_out += u.get("output_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            have_usage = true;
        }

        let content = v
            .get("content")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();

        let tool_uses: Vec<&Value> = content
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
            .collect();

        if !tool_uses.is_empty() {
            if !in_think {
                emit_token(app, sid, "<think>", &mut full);
                in_think = true;
            }
            // Echo the assistant turn (text + tool_use blocks) verbatim.
            messages.push(json!({ "role": "assistant", "content": content }));

            let mut results: Vec<Value> = Vec::new();
            for tu in &tool_uses {
                let id = tu.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let name = tu.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let args = tu.get("input").cloned().unwrap_or_else(|| json!({}));

                emit_token(app, sid, &tool_status_line(&name, &args), &mut full);
                let result = run_tool(client, &art_dir, caps, app, sid, &name, &args).await;
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": result,
                }));
            }
            messages.push(json!({ "role": "user", "content": results }));
            continue;
        }

        // No tool use → final answer: concatenate text blocks.
        if in_think {
            emit_token(app, sid, "</think>", &mut full);
        }
        let text: String = content
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("");
        emit_token(app, sid, &text, &mut full);
        return Ok((full, build_usage(false, total_in, total_out, have_usage)));
    }

    if in_think {
        emit_token(app, sid, "</think>", &mut full);
    }
    emit_token(
        app,
        sid,
        "\n\n_Stopped after reaching the tool-call limit._",
        &mut full,
    );
    Ok((full, build_usage(false, total_in, total_out, have_usage)))
}

/// Build a `ChatUsage` summing across all tool-loop round-trips, picking the
/// provider's cost model.
fn build_usage(openai: bool, input: i64, output: i64, have: bool) -> Option<ChatUsage> {
    if !have {
        return None;
    }
    let cost = if openai {
        calculate_openai_cost(input, output)
    } else {
        calculate_anthropic_cost(input, output)
    };
    Some(ChatUsage {
        input_tokens: input,
        output_tokens: output,
        cost_usd: cost,
    })
}

fn resolve_provider(id: &ChatProviderId) -> Box<dyn ChatProvider> {
    use providers::*;
    match id {
        ChatProviderId::Anthropic => Box::new(AnthropicProvider),
        ChatProviderId::OpenAI => Box::new(OpenAIProvider),
        ChatProviderId::AnthropicCompatible => Box::new(AnthropicCompatibleProvider),
        ChatProviderId::OpenAICompatible => Box::new(OpenAICompatibleProvider),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tool_args_plain_object() {
        let v = parse_tool_args(r#"{"query":"rust"}"#);
        assert_eq!(v["query"], "rust");
    }

    #[test]
    fn parse_tool_args_recovers_from_prepended_empty_object() {
        // Observed from an OpenAI-compatible proxy.
        let v = parse_tool_args(r#"{}{"query": "population of France"}"#);
        assert_eq!(v["query"], "population of France");
    }

    #[test]
    fn parse_tool_args_merges_concatenated_objects() {
        let v = parse_tool_args(r#"{"a":1}{"b":2}"#);
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"], 2);
    }

    #[test]
    fn parse_tool_args_empty_is_object() {
        assert_eq!(parse_tool_args(""), json!({}));
        assert_eq!(parse_tool_args("   "), json!({}));
    }

    #[test]
    fn parse_hermes_web_search_cow() {
        // Exact payload observed from an OpenAI-compatible aggregator: the
        // model emitted its trained Hermes tool-call format as plain text in
        // `content` instead of populating `tool_calls`.
        let content = "Let me search for \"cow\" in the browser.\n\n<tool_calls>\n<invoke name=\"web_search\">\n<parameter name=\"query\" string=\"true\">cow</parameter>\n</invoke>\n</tool_calls>";
        let calls = parse_hermes_tool_calls(content).expect("should recover a call");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "web_search");
        assert_eq!(calls[0].1["query"], "cow");
    }

    #[test]
    fn parse_hermes_generate_document_docx() {
        // The exact docx artifact request that was being echoed as text.
        let content = "Sure — I'll generate a clean sample Word document.\n\n<tool_calls>\n<invoke name=\"generate_document\">\n<parameter name=\"format\" type=\"string\">docx</parameter>\n<parameter name=\"instructions\" type=\"string\">Create a sample Word document with a title, sections, a bulleted list, and a 3x3 table.</parameter>\n</invoke>\n</tool_calls>";
        let calls = parse_hermes_tool_calls(content).expect("should recover a call");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "generate_document");
        assert_eq!(calls[0].1["format"], "docx");
        assert!(calls[0].1["instructions"].as_str().unwrap().contains("table"));
    }

    #[test]
    fn parse_hermes_multiple_invokes() {
        let content = "<tool_calls>\n<invoke name=\"web_search\">\n<parameter name=\"query\">one</parameter>\n</invoke>\n<invoke name=\"fetch_url\">\n<parameter name=\"url\">https://example.com</parameter>\n</invoke>\n</tool_calls>";
        let calls = parse_hermes_tool_calls(content).expect("should recover both calls");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "web_search");
        assert_eq!(calls[0].1["query"], "one");
        assert_eq!(calls[1].0, "fetch_url");
        assert_eq!(calls[1].1["url"], "https://example.com");
    }

    #[test]
    fn parse_hermes_none_when_no_block() {
        assert!(parse_hermes_tool_calls("Just a normal answer.").is_none());
        assert!(parse_hermes_tool_calls("").is_none());
    }

    #[test]
    fn parse_hermes_coerces_types() {
        // Booleans, ints, floats and JSON values should be typed, not stringified.
        let content = "<tool_calls>\n<invoke name=\"run_code\">\n<parameter name=\"language\">python</parameter>\n<parameter name=\"enabled\">true</parameter>\n<parameter name=\"count\">3</parameter>\n<parameter name=\"ratio\">1.5</parameter>\n<parameter name=\"opts\">{\"a\": 1}</parameter>\n</invoke>\n</tool_calls>";
        let calls = parse_hermes_tool_calls(content).unwrap();
        let args = &calls[0].1;
        assert_eq!(args["language"], "python");
        assert_eq!(args["enabled"], true);
        assert_eq!(args["count"], 3);
        assert!((args["ratio"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        assert_eq!(args["opts"]["a"], 1);
    }

    #[test]
    fn strip_hermes_removes_markup_keeps_prose() {
        let content = "Let me search for \"cow\".\n\n<tool_calls>\n<invoke name=\"web_search\">\n<parameter name=\"query\">cow</parameter>\n</invoke>\n</tool_calls>";
        let stripped = strip_hermes_tool_calls(content);
        assert!(stripped.contains("Let me search"));
        assert!(!stripped.contains("tool_calls"));
        assert!(!stripped.contains("invoke"));
    }

    #[test]
    fn strip_hermes_handles_unclosed_block() {
        // A model that kept streaming the call without closing the tag.
        let content = "Thinking… <tool_calls><invoke name=\"web_search\"><parameter name=\"query\">cow";
        let stripped = strip_hermes_tool_calls(content);
        assert_eq!(stripped, "Thinking…");
    }
}
