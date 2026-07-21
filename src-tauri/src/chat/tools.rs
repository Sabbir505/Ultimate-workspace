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

use super::{artifacts, codeexec};

/// Names of every tool the model may call. Kept in one place so the specs and
/// the dispatcher can't drift apart.
pub const WEB_SEARCH: &str = "web_search";
pub const GENERATE_FILE: &str = "generate_file";
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

const GENERATE_FILE_DESC: &str = "Generate a downloadable file/artifact for the \
    user and save it to disk. Use for documents, reports, spreadsheets and \
    slide decks. For pptx, separate slides with a line containing only '---'; \
    the first line of each slide is its title and remaining lines are bullets. \
    For xlsx/csv, provide comma-separated rows (one row per line).";

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
