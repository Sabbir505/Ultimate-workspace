//! Chat tools — the capabilities the model can invoke during a chat turn
//! (function/tool calling), plus their implementations.
//!
//! The registry is provider-agnostic: [`openai_tool_specs`] and
//! [`anthropic_tool_specs`] render the same tools into each wire format, and
//! [`execute_tool`] dispatches a tool call (by name + JSON arguments) to its
//! implementation. New capabilities are added by registering a spec here and a
//! branch in `execute_tool`.

use serde_json::{json, Value};

/// Names of every tool the model may call. Kept in one place so the specs and
/// the dispatcher can't drift apart.
pub const WEB_SEARCH: &str = "web_search";

/// OpenAI `tools` array (`{type:"function", function:{...}}` entries).
pub fn openai_tool_specs() -> Vec<Value> {
    vec![json!({
        "type": "function",
        "function": {
            "name": WEB_SEARCH,
            "description": "Search the public web for up-to-date information. \
                Returns a list of result titles, URLs and snippets. Use this \
                whenever the answer may depend on current events or facts you \
                are unsure about.",
            "parameters": web_search_parameters(),
        }
    })]
}

/// Anthropic `tools` array (`{name, description, input_schema}` entries).
pub fn anthropic_tool_specs() -> Vec<Value> {
    vec![json!({
        "name": WEB_SEARCH,
        "description": "Search the public web for up-to-date information. \
            Returns a list of result titles, URLs and snippets. Use this \
            whenever the answer may depend on current events or facts you are \
            unsure about.",
        "input_schema": web_search_parameters(),
    })]
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

/// Dispatch a tool call to its implementation. `args` is the JSON object of
/// arguments the model produced. Returns the tool result as a string that is
/// fed back to the model as a `tool` / `tool_result` message.
pub async fn execute_tool(client: &reqwest::Client, name: &str, args: &Value) -> String {
    match name {
        WEB_SEARCH => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            if query.trim().is_empty() {
                return "Error: web_search requires a non-empty \"query\".".to_string();
            }
            match web_search(client, query).await {
                Ok(results) => results,
                Err(e) => format!("web_search failed: {e}"),
            }
        }
        other => format!("Error: unknown tool \"{other}\"."),
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

    #[test]
    fn openai_spec_has_web_search() {
        let specs = openai_tool_specs();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0]["function"]["name"], WEB_SEARCH);
        assert_eq!(specs[0]["type"], "function");
        assert!(specs[0]["function"]["parameters"]["properties"]["query"].is_object());
    }

    #[test]
    fn anthropic_spec_has_web_search() {
        let specs = anthropic_tool_specs();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0]["name"], WEB_SEARCH);
        assert!(specs[0]["input_schema"]["properties"]["query"].is_object());
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
    fn web_search_live_returns_results() {
        let client = reqwest::Client::new();
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            WEB_SEARCH,
            &json!({ "query": "rust programming language" }),
        ));
        println!("{out}");
        assert!(out.contains("Search results"));
        assert!(out.contains("http"));
    }

    #[test]
    fn execute_unknown_tool_reports_error() {
        let client = reqwest::Client::new();
        let out = tauri::async_runtime::block_on(execute_tool(
            &client,
            "does_not_exist",
            &json!({}),
        ));
        assert!(out.contains("unknown tool"));
    }
}
