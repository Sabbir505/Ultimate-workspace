//! Web text extraction for the chat tools: `fetch_url` (readable text from a
//! single URL) and `web_search` (keyless SERP via DuckDuckGo + Wikipedia).
//!
//! Both produce plain text the model consumes. A real browser User-Agent is
//! sent on every request so CDNs/WAFs (Cloudflare) do not 403 us.

use std::net::IpAddr;

use serde_json::Value;

/// A real browser User-Agent. Many CDNs/WAFs (Cloudflare in particular) 403
/// requests with an unknown UA like the old "Conduit/0.1" string, which made
/// `fetch_url` and the SERP scraper look "non-functional" to the model.
const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
     Chrome/131.0.0.0 Safari/537.36";

/// Hard cap on how many response bytes `fetch_url` will buffer into RAM before
/// giving up. Truncation to 12 KB for the model happens AFTER this point, but
/// capping the raw body size stops a hostile server streaming gigabytes from
/// OOM-killing the Tauri backend. 1 MiB is well above any reasonable article.
const FETCH_URL_MAX_BODY_BYTES: usize = 1_048_576;

/// True when `ip` is in a range that a malicious model should never be able to
/// reach from `fetch_url` / `download_file`: loopback, link-local
/// (cloud-metadata / link-local), private RFC1918, CGNAT, ULA, multicast,
/// unspecified, broadcast, and reserved.
pub fn is_blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_private()
                // CGNAT 100.64.0.0/10 (carrier-grade NAT) — the doc comment
                // above claims this is blocked; without it, ISP-internal
                // services are reachable. `is_shared()` is still an unstable
                // library feature (rust#27709), so match the /10 manually.
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 0x40)
                || v4.is_documentation()
        }
        IpAddr::V6(v6) => {
            // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
            // addresses smuggle a V4 address past every V6 check below —
            // `[::ffff:127.0.0.1]` is NOT `is_loopback()`. Unwrap the
            // embedded V4 and apply the V4 rules to it. (`to_ipv4` covers
            // both mapped and compatible forms; ::1 is neither and falls
            // through to the V6 checks.)
            if let Some(v4) = v6.to_ipv4() {
                return is_blocked_ip(&IpAddr::V4(v4));
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // Unique-local (fc00::/7) — RFC4193
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // Link-local (fe80::/10)
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // Documentation (2001:db8::/32) — parity with the V4 arm
                || (v6.segments()[0] == 0x2001 && v6.segments()[1] == 0x0db8)
        }
    }
}

/// True when `host` resolves to an IP in a blocked range (or fails to
/// resolve). Fails closed — unresolvable hostnames are rejected. DNS-rebinding
/// is mitigated by re-checking `resp.remote_addr()` after the TCP connect.
pub fn host_blocked(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = h.parse::<IpAddr>() {
        return is_blocked_ip(&ip);
    }
    let addrs: Vec<IpAddr> = match std::net::ToSocketAddrs::to_socket_addrs(h) {
        Ok(it) => it
            .filter_map(|s| match s.ip() {
                IpAddr::V4(v4) => Some(IpAddr::V4(v4)),
                IpAddr::V6(v6) => Some(IpAddr::V6(v6)),
            })
            .collect(),
        Err(_) => return true,
    };
    if addrs.is_empty() {
        return true;
    }
    addrs.iter().any(is_blocked_ip)
}

/// Fetch a URL and return its readable text (HTML stripped, truncated).
///
/// On HTTP failure the error is returned as `Err(...)` and surfaced to the
/// model verbatim ("fetch_url failed: HTTP 403 Forbidden") so it can report the
/// real reason rather than guessing. The model's tendency to call a single
/// 403/timeout "non-functional" is addressed at the source: a browser
/// User-Agent (so Cloudflare stops 403'ing us) and a 30s timeout (was 15s,
/// too tight for slow JS-heavy news sites).
pub(super) async fn fetch_url(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("url must start with http:// or https://".to_string());
    }
    // Parse out the host and reject blocked address ranges (SSRF guard).
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    if let Some(host) = parsed.host_str() {
        if host_blocked(host) {
            return Err(format!(
                "fetch_url refused: `{host}` resolves to a loopback, link-local, \
                 private, or otherwise blocked address range (SSRF guard)."
            ));
        }
    }
    let resp = client
        .get(url)
        .header("User-Agent", BROWSER_UA)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    // DNS-rebinding guard: re-verify the resolved peer IP after the TCP
    // connection has been opened.
    if let Some(peer) = resp.remote_addr() {
        if is_blocked_ip(&peer.ip()) {
            return Err(format!(
                "fetch_url refused: peer {} is in a blocked address range \
                 (DNS-rebinding guard).",
                peer.ip()
            ));
        }
    }
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    // Read the body with a hard byte cap so a hostile server can't OOM the
    // process by streaming gigabytes of HTML.
    let mut body_buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("read body: {e}"))?;
        if body_buf.len() + chunk.len() > FETCH_URL_MAX_BODY_BYTES {
            return Err(format!(
                "fetch_url refused: response body exceeds {FETCH_URL_MAX_BODY_BYTES} byte cap (sandbox limit)."
            ));
        }
        body_buf.extend_from_slice(&chunk);
    }
    let body = match String::from_utf8(body_buf) {
        Ok(s) => s,
        Err(_) => return Err("fetch_url response is not valid UTF-8".to_string()),
    };
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
///
/// `fetch_url` has no live webview to run the Readability bridge in (see
/// `browser.rs::read_page`), so it falls back to this tag-stripper. To keep
/// the output focused on article text rather than nav/footer/cookie-banner
/// noise — which previously made the model think the tool was "broken" — we
/// drop the common chrome block tags entirely before stripping inline tags.
fn html_to_text(html: &str) -> String {
    let without_blocks = remove_blocks(
        html,
        &[
            "script",
            "style",
            "noscript",
            "head",
            "svg",
            // Page chrome that carries no article content and would otherwise
            // drown the real text in nav links / cookie notices / ad slots.
            "nav",
            "header",
            "footer",
            "aside",
            "form",
            "iframe",
        ],
    );
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


struct SearchHit {
    title: String,
    url: String,
    snippet: String,
}

/// Free, no-API-key web search. Primary source is the DuckDuckGo HTML results
/// page (a *real* SERP, unlike the Instant Answer API which only fires for
/// encyclopedic entities). The Instant Answer API and Wikipedia are kept as
/// cheap secondary sources for encyclopedic color. Results are merged,
/// de-duplicated, and rendered as a plain-text list for the model.
///
/// Network errors from each source are tracked separately so the caller can
/// distinguish "no public results" from "the search backend was unreachable":
/// if *every* source errored, we return an explicit `Err` instead of the
/// misleading "No results found" string (which the model read as "tool broken").
pub(super) async fn web_search(client: &reqwest::Client, query: &str) -> Result<String, String> {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut sources_tried = 0u32;

    sources_tried += 1;
    match duckduckgo_html(client, query).await {
        Ok(mut v) => hits.append(&mut v),
        Err(e) => errors.push(format!("duckduckgo_html: {e}")),
    }

    sources_tried += 1;
    match duckduckgo_instant(client, query).await {
        Ok(mut v) => hits.append(&mut v),
        Err(e) => errors.push(format!("duckduckgo_instant: {e}")),
    }

    sources_tried += 1;
    match wikipedia_search(client, query).await {
        Ok(mut v) => hits.append(&mut v),
        Err(e) => errors.push(format!("wikipedia: {e}")),
    }

    // De-duplicate by URL, preserving order.
    let mut seen = std::collections::HashSet::new();
    hits.retain(|h| !h.url.is_empty() && seen.insert(h.url.clone()));

    if hits.is_empty() {
        // If every source failed with a network/HTTP error, that is NOT "no
        // results" — it is "search is unreachable". Surface it as an error so
        // the model tells the user the backend is down instead of claiming the
        // query has no results (which it would otherwise parrot).
        if errors.len() as u32 == sources_tried {
            return Err(format!(
                "all search backends failed: {}",
                errors.join("; ")
            ));
        }
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

/// The DuckDuckGo **HTML** results endpoint (`html.duckduckgo.com/html/`) is a
/// real search-engine results page — unlike the Instant Answer API, it returns
/// organic web results for *any* query, not just known entities. We GET it with
/// a browser User-Agent and parse the result anchors out of the (small, stable)
/// HTML the lite endpoint emits. This is the keyless primary search source.
async fn duckduckgo_html(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<SearchHit>, String> {
    let url = "https://html.duckduckgo.com/html/";
    let resp = client
        .get(url)
        .header("User-Agent", BROWSER_UA)
        .timeout(std::time::Duration::from_secs(10))
        .query(&[("q", query)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(parse_duckduckgo_html(&body))
}

/// Parse the DuckDuckGo lite/HTML results page. Result links live in
/// `<a class="result__a" href="...">Title</a>` anchors with a sibling
/// `<a class="result__snippet">...</a>` snippet. DDG wraps the real URL in a
/// `//duckduckgo.com/l/?uddg=<encoded>` redirector for some results; we unwrap
/// the `uddg` parameter when present so the model gets the canonical URL.
fn parse_duckduckgo_html(html: &str) -> Vec<SearchHit> {
    let lower = html.to_ascii_lowercase();
    let mut hits = Vec::new();
    let anchor = "class=\"result__a\"";
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find(anchor) {
        let a_pos = search_from + rel;
        search_from = a_pos + anchor.len();

        // The result anchor opens somewhere before `class="result__a"`; walk
        // back to the opening `<a ` and treat everything up to the closing `>`
        // as the full opening tag, so `href` (which DDG places *after* the
        // class attribute) is included in the slice we parse.
        let open = match lower[..a_pos].rfind("<a ") {
            Some(p) => p,
            None => continue,
        };
        let close_gt = match lower[a_pos..].find('>') {
            Some(g) => a_pos + g,
            None => continue,
        };
        let open_tag = &html[open..close_gt];
        let href = extract_attr(open_tag, "href").unwrap_or_default();
        let url = unwrap_ddg_redirect(&href);
        if url.is_empty() || !(url.starts_with("http://") || url.starts_with("https://")) {
            continue;
        }
        // Title is the text between this `>` and the closing `</a>`.
        let gt = close_gt + 1;
        let end = match lower[gt..].find("</a>") {
            Some(e) => gt + e,
            None => continue,
        };
        let title = strip_html(&html[gt..end]);
        if title.is_empty() {
            continue;
        }
        // Snippet: the next `result__snippet` anchor after this result.
        let snippet = lower[search_from..]
            .find("class=\"result__snippet\"")
            .and_then(|s_rel| {
                let s_pos = search_from + s_rel;
                let s_gt = lower[s_pos..].find('>').map(|g| s_pos + g + 1)?;
                let s_end = lower[s_gt..].find("</a>").map(|e| s_gt + e)?;
                Some(strip_html(&html[s_gt..s_end]))
            })
            .unwrap_or_default();
        hits.push(SearchHit {
            title,
            url,
            snippet,
        });
    }
    hits
}

/// Read an attribute value from a tag fragment like `<a class="x" href="y">`.
/// Returns the unescaped value, or None if absent. Handles single/double
/// quotes and bare values.
fn extract_attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let key = format!("{name}=");
    let idx = lower.find(&key)?;
    let val_start = idx + key.len();
    let bytes = tag.as_bytes();
    if val_start >= bytes.len() {
        return None;
    }
    let quote = bytes[val_start];
    if quote == b'"' || quote == b'\'' {
        let rest = &tag[val_start + 1..];
        let end = rest.find(quote as char)?;
        Some(decode_html_entities(&rest[..end]))
    } else {
        // Unquoted value: ends at whitespace or `>`.
        let rest = &tag[val_start..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(rest.len());
        Some(decode_html_entities(&rest[..end]))
    }
}

/// Decode the handful of HTML entities that appear in attribute values. Not a
/// full entity decoder — just the common ones — which is enough for search
/// result URLs/snippets.
fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// DDG result hrefs are sometimes wrapped as
/// `//duckduckgo.com/l/?uddg=<percent-encoded real url>&...`. Unwrap to the
/// real URL; otherwise return the href unchanged.
fn unwrap_ddg_redirect(href: &str) -> String {
    let h = href.trim();
    if !h.contains("uddg=") {
        return h.to_string();
    }
    let after = h.split("uddg=").nth(1).unwrap_or("");
    let encoded = after.split('&').next().unwrap_or("");
    if encoded.is_empty() {
        return h.to_string();
    }
    percent_decode(encoded)
}

/// Minimal percent-decoding for the `uddg` parameter value.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

async fn duckduckgo_instant(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<SearchHit>, String> {
    let url = "https://api.duckduckgo.com/";
    let resp = client
        .get(url)
        .header("User-Agent", BROWSER_UA)
        .timeout(std::time::Duration::from_secs(10))
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
        .header("User-Agent", BROWSER_UA)
        .timeout(std::time::Duration::from_secs(10))
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

// =====================
// Filesystem tool impls
// =====================
//
// These operate on the real absolute paths the model passes. The permission
// gate (auto-run vs. approval card) is enforced by the caller; these branches
// only run for actions that have been authorized. They are intentionally
// straightforward — no traversal tricks, no shell-out — and report errors as
// plain text fed back to the model so it can self-correct.


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn parse_duckduckgo_html_extracts_organic_results() {
        // Minimal slice of the html.duckduckgo.com/html/ SERP shape: a
        // result anchor with a uddg-redirect href and a sibling snippet. Uses
        // r##"..."## because the payloads contain `"#` which would end a
        // single-hash raw string early.
        let html = concat!(
            r##"<div class="result"><a rel="nofollow" class="result__a" "##,
            r##"href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frust-lang.org%2F&rut=abc">"##,
            r##"Rust Programming Language</a>"##,
            r##"<a class="result__snippet" href="#">A systems language...</a></div>"##,
            r##"<div class="result"><a class="result__a" href="https://example.org">"##,
            r##"Example Title</a></div>"##,
        );
        let hits = parse_duckduckgo_html(html);
        assert_eq!(hits.len(), 2, "both results parsed");
        assert_eq!(hits[0].title, "Rust Programming Language");
        assert_eq!(
            hits[0].url,
            "https://rust-lang.org/",
            "uddg redirect must be unwrapped and percent-decoded"
        );
        assert_eq!(hits[0].snippet, "A systems language...");
        assert_eq!(hits[1].title, "Example Title");
        assert_eq!(hits[1].url, "https://example.org");
        assert!(hits[1].snippet.is_empty(), "missing snippet stays empty");
    }

    #[test]
    fn parse_duckduckgo_html_skips_non_http_links() {
        // In-page anchors (href="#fragment") must not become bogus search hits.
        let html = r##"<a class="result__a" href="#more">More</a>"##;
        let hits = parse_duckduckgo_html(html);
        assert!(hits.is_empty(), "non-http hrefs are dropped");
    }

    #[test]
    fn unwrap_ddg_redirect_passes_through_plain_urls() {
        assert_eq!(
            unwrap_ddg_redirect("https://example.org/path"),
            "https://example.org/path"
        );
        assert_eq!(
            unwrap_ddg_redirect("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fx&q=1"),
            "https://example.org/x"
        );
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
    fn ssrf_guard_blocks_ipv4_smuggled_as_ipv6() {
        use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
        // IPv4-mapped loopback/private must be blocked (was the bypass).
        let mapped_loop: IpAddr = "::ffff:127.0.0.1".parse().unwrap();
        assert!(is_blocked_ip(&mapped_loop));
        let mapped_priv: IpAddr = "::ffff:10.0.0.5".parse().unwrap();
        assert!(is_blocked_ip(&mapped_priv));
        let mapped_cgnat: IpAddr = "::ffff:100.64.0.1".parse().unwrap();
        assert!(is_blocked_ip(&mapped_cgnat));
        // IPv4-compatible (deprecated) form too.
        let compat_loop: IpAddr = "::127.0.0.1".parse().unwrap();
        assert!(is_blocked_ip(&compat_loop));
        // …but a mapped PUBLIC v4 is still allowed (guard must not over-block).
        let mapped_public: IpAddr = "::ffff:8.8.8.8".parse().unwrap();
        assert!(!is_blocked_ip(&mapped_public));
        assert!(!is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_blocked_ip(&IpAddr::V6(
            "2606:4700:4700::1111".parse::<Ipv6Addr>().unwrap()
        )));
    }

    #[test]
    fn ssrf_guard_blocks_cgnat_and_v6_documentation() {
        use std::net::IpAddr;
        // CGNAT 100.64.0.0/10 (carrier-grade NAT) — claimed by the doc
        // comment but previously unblocked.
        let cgnat: IpAddr = "100.64.0.1".parse().unwrap();
        assert!(is_blocked_ip(&cgnat));
        let not_cgnat: IpAddr = "100.63.255.255".parse().unwrap();
        assert!(!is_blocked_ip(&not_cgnat));
        // V6 documentation range, parity with the V4 arm.
        let v6doc: IpAddr = "2001:db8::1".parse().unwrap();
        assert!(is_blocked_ip(&v6doc));
    }

    #[test]
    fn ssrf_guard_bracketed_mapped_host_literal() {
        // host_blocked strips the URL bracket form before parsing.
        assert!(host_blocked("[::ffff:127.0.0.1]"));
        assert!(host_blocked("::ffff:127.0.0.1"));
    }

}
