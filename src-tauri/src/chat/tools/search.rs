//! Web text extraction for the chat tools: `fetch_url` (readable text from a
//! single URL) and `web_search` (keyless multi-engine SERP).
//!
//! Both produce plain text the model consumes. A real browser User-Agent is
//! sent on every request so CDNs/WAFs (Cloudflare) do not 403 us.
//!
//! `fetch_url` extracts article content with `dom_smoothie` (a Readability.js
//! port — the same algorithm family as Firefox Reader Mode and the in-app
//! browser bridge), falls back to the old tag-stripper when Readability can't
//! find an article, and falls back to the keyless Jina Reader
//! (`r.jina.ai`) when the direct fetch is blocked or the target is a PDF.
//! `web_search` merges results from DuckDuckGo's HTML SERP, Mojeek, and
//! Wikipedia, tolerating any single engine failing, and reports per-engine
//! health so "no results" vs "engine down" stays distinguishable.
//!
//! Anti-bot walls: DDG and Mojeek increasingly answer scraper-shaped traffic
//! with CAPTCHA/403 pages. A blocked page is detected (marker heuristics) and
//! reported as an ENGINE FAILURE, never as "ok (0 results)" — that keeps the
//! caller's fallback chain honest. The caller (dispatch) escalates to the
//! in-app browser pane ([`super::serp_browser`], a real WebView with a real
//! fingerprint) and then to the Jina Reader SERP before giving up.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use serde_json::Value;

/// A real browser User-Agent. Many CDNs/WAFs (Cloudflare in particular) 403
/// requests with an unknown UA like the old "Relay/0.1" string, which made
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
            // Loopback/unspecified/multicast FIRST: `to_ipv4()` below converts
            // the IPv4-COMPATIBLE form too, so `::1` became 0.0.0.1 and slipped
            // past every V4 rule (loopback is only 127.0.0.0/8 in V4) — the
            // bracketed-loopback SSRF shape `http://[::1]:8080/` was reachable.
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return true;
            }
            // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
            // addresses smuggle a V4 address past every V6 check below —
            // `[::ffff:127.0.0.1]` is NOT `is_loopback()`. Unwrap the
            // embedded V4 and apply the V4 rules to it.
            if let Some(v4) = v6.to_ipv4() {
                return is_blocked_ip(&IpAddr::V4(v4));
            }
            // Unique-local (fc00::/7) — RFC4193
            (v6.segments()[0] & 0xfe00) == 0xfc00
                // Link-local (fe80::/10)
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // Documentation (2001:db8::/32) — parity with the V4 arm
                || (v6.segments()[0] == 0x2001 && v6.segments()[1] == 0x0db8)
        }
    }
}

/// True when a proxy is configured via environment (HTTP(S)_PROXY /
/// ALL_PROXY — the common Clash/V2Ray setup). reqwest honors these by
/// default, which changes what the SSRF guards can meaningfully check: the
/// TCP peer becomes the PROXY (127.0.0.1:7890), not the target host.
pub(super) fn proxy_env_set() -> bool {
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
        .iter()
        .any(|k| std::env::var(k).is_ok_and(|v| !v.trim().is_empty()))
}

/// True when `host` resolves to an IP in a blocked range (or fails to
/// resolve). Fails closed — unresolvable hostnames are rejected. DNS-rebinding
/// is mitigated by re-checking `resp.remote_addr()` after the TCP connect.
///
/// Resolution uses `(host, 0)` — the `(&str, u16)` `ToSocketAddrs` impl
/// performs the DNS lookup and ignores the port. The bare-`&str` impl
/// requires `host:port` and ERRORS on every plain hostname, which (with the
/// fail-closed `Err => true` below) refused EVERY domain — fetch_url was a
/// hard wall, pushing models onto the local file-search tools for web
/// questions.
///
/// Proxy environments skip the DNS-resolution half entirely: the connection
/// egresses through the user's proxy (which does its own resolution), so a
/// local lookup — often broken or fake-IP under TUN-mode setups — says
/// nothing about the real target. Literal-IP hosts (the actual SSRF shapes:
/// `http://127.0.0.1/`, `http://169.254.169.254/`) are still blocked by name.
pub fn host_blocked(host: &str) -> bool {
    host_blocked_in(host, proxy_env_set())
}

/// `host_blocked` with the proxy decision injected — tests pin both sides
/// (the process env leaks into `cargo test`, so the wrapper alone can't be
/// asserted deterministically).
pub(crate) fn host_blocked_in(host: &str, proxied: bool) -> bool {
    use std::net::ToSocketAddrs;
    let h = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = h.parse::<IpAddr>() {
        return is_blocked_ip(&ip);
    }
    if proxied {
        return false;
    }
    let addrs: Vec<IpAddr> = match (h, 0u16).to_socket_addrs() {
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

/// Upper bound on response text handed to the model from `fetch_url` (chars,
/// truncated on a char boundary AFTER extraction). Raised from 12 KB to 32 KB:
/// Readability output is focused article text, and research-mode reads of
/// long primary sources were silently losing half the document at 12 KB.
const FETCH_URL_MAX_TEXT_CHARS: usize = 32_000;

/// Keyless Jina Reader rate limit: the no-key tier allows 20 requests per
/// minute. A rolling window shared process-wide keeps a research turn that
/// fans out several blocked fetches from burning the whole budget at once.
const JINA_RPM: usize = 20;

/// Rolling-window rate limiter for the keyless Jina Reader tier.
struct JinaRateLimiter {
    hits: std::sync::Mutex<VecDeque<Instant>>,
}

static JINA_LIMITER: std::sync::LazyLock<JinaRateLimiter> = std::sync::LazyLock::new(|| {
    JinaRateLimiter {
        hits: std::sync::Mutex::new(VecDeque::new()),
    }
});

/// True when a Jina request is allowed under the rolling 20 RPM window;
/// records the hit when allowed.
fn jina_rate_limit_ok() -> bool {
    let mut q = match JINA_LIMITER.hits.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let now = Instant::now();
    while let Some(front) = q.front() {
        if now.duration_since(*front) > Duration::from_secs(60) {
            q.pop_front();
        } else {
            break;
        }
    }
    if q.len() >= JINA_RPM {
        return false;
    }
    q.push_back(now);
    true
}

/// True when `url` points at a PDF (by extension — the content-type check
/// happens after the response headers arrive).
fn is_probable_pdf_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or("");
    path.to_ascii_lowercase().ends_with(".pdf")
}

/// Fetch a URL through the keyless Jina Reader (`https://r.jina.ai/<url>`),
/// which renders JS-heavy pages, bypasses many CDN blocks, and parses PDFs
/// server-side. Returns the reader's markdown output with its Title/URL
/// header retained. The caller MUST have passed the target through the SSRF
/// host guard first — routing a private/loopback URL through a public reader
/// would otherwise launder it past `fetch_url`'s address checks.
async fn fetch_url_via_jina(client: &reqwest::Client, url: &str) -> Result<String, String> {
    if !jina_rate_limit_ok() {
        return Err(
            "jina reader rate limit reached (20 req/min keyless); retry in a minute \
             or read the page in the browser pane instead."
                .to_string(),
        );
    }
    let reader_url = format!("https://r.jina.ai/{url}");
    let resp = client
        .get(&reader_url)
        .header("User-Agent", BROWSER_UA)
        .header("Accept", "text/plain")
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(|e| format!("jina reader request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("jina reader returned HTTP {status}"));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if body.trim().is_empty() {
        return Err("jina reader returned an empty document".to_string());
    }
    Ok(truncate_chars(&body, FETCH_URL_MAX_TEXT_CHARS))
}

/// Truncate `s` to at most `max` chars on a char boundary, appending an
/// ellipsis marker when cut.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n… (content truncated)", &s[..cut])
}

/// Fetch a URL and return its readable text (Readability-extracted, truncated).
///
/// Pipeline: (1) direct GET with the SSRF guards; a PDF content-type or a
/// blocked/failed direct fetch falls back to the keyless Jina Reader, which
/// renders JS-heavy pages and parses PDFs server-side; (2) HTML responses are
/// extracted with `dom_smoothie` (Readability.js port); if Readability finds
/// no article, the old tag-stripper takes over so non-article pages (web
/// apps, docs indexes) still yield text.
///
/// On total failure the error is returned as `Err(...)` and surfaced to the
/// model verbatim so it can report the real reason rather than guessing.
pub(crate) async fn fetch_url(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("url must start with http:// or https://".to_string());
    }
    // Parse out the host and reject blocked address ranges (SSRF guard).
    // This runs BEFORE both the direct fetch and the Jina fallback — the
    // reader must never be handed a private/loopback target it would fetch
    // on our behalf.
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    if let Some(host) = parsed.host_str() {
        if host_blocked(host) {
            return Err(format!(
                "fetch_url refused: `{host}` resolves to a loopback, link-local, \
                 private, or otherwise blocked address range (SSRF guard)."
            ));
        }
    }

    let direct = fetch_url_direct(client, url).await;
    match direct {
        Ok(FetchBody::Html(html)) => Ok(extract_html(url, &html)),
        Ok(FetchBody::Pdf) => {
            // Binary content is useless to the model — the reader parses it.
            fetch_url_via_jina(client, url)
                .await
                .map_err(|e| format!("PDF fetch failed: {e}"))
        }
        Err(direct_err) => {
            // Blocked/broken direct fetch → one reader retry before giving up.
            fetch_url_via_jina(client, url).await.map_err(|jina_err| {
                format!("direct fetch failed ({direct_err}); reader fallback failed ({jina_err})")
            })
        }
    }
}

/// What the direct fetch produced: extractable HTML, or a binary document
/// (PDF) the text pipeline must not touch.
enum FetchBody {
    Html(String),
    Pdf,
}

async fn fetch_url_direct(client: &reqwest::Client, url: &str) -> Result<FetchBody, String> {
    let resp = client
        .get(url)
        .header("User-Agent", BROWSER_UA)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    // DNS-rebinding guard: re-verify the resolved peer IP after the TCP
    // connection has been opened. SKIPPED when a proxy is configured: the
    // TCP peer is then the proxy itself (e.g. 127.0.0.1:7890 — Clash), which
    // the blocklist always refuses, so this check rejected EVERY fetch in
    // proxied setups (the "DNS-rebinding guard refuses all connections"
    // failure the subagents kept reporting). The pre-connect host_blocked()
    // name check still guards literal private/loopback hosts.
    if !proxy_env_set() {
        if let Some(peer) = resp.remote_addr() {
            if is_blocked_ip(&peer.ip()) {
                return Err(format!(
                    "fetch_url refused: peer {} is in a blocked address range \
                     (DNS-rebinding guard).",
                    peer.ip()
                ));
            }
        }
    }
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    // PDFs (content-type or extension) route to the reader — decoding PDF
    // bytes as UTF-8 text produces garbage that used to poison the ledger.
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("application/pdf") || is_probable_pdf_url(url) {
        return Ok(FetchBody::Pdf);
    }
    // Read the body with a hard byte cap so a hostile server can't OOM the
    // process by streaming gigabytes of HTML. Over-cap pages are TRUNCATED
    // and still extracted, not refused: heavy reference pages (Wikipedia
    // articles with large tables) legitimately exceed 1 MiB of raw HTML
    // while extracting to well under the text budget — refusing them sent
    // every such read to the reader fallback (which 403s on some domains)
    // or failed the read entirely.
    let mut body_buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("read body: {e}"))?;
        if body_buf.len() + chunk.len() > FETCH_URL_MAX_BODY_BYTES {
            let remaining = FETCH_URL_MAX_BODY_BYTES - body_buf.len();
            body_buf.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        body_buf.extend_from_slice(&chunk);
    }
    let _ = truncated; // extraction quality note only; the text cap governs output
    // Lossy: a truncate may split a multi-byte char mid-sequence.
    let body = String::from_utf8_lossy(&body_buf).into_owned();
    Ok(FetchBody::Html(body))
}

/// Extract readable article text from an HTML document: `dom_smoothie`
/// (Readability.js port) first, the legacy tag-stripper as fallback for
/// non-article pages. Returns the same `Title: …\nURL: …\n\n<body>` envelope
/// the tool has always produced.
fn extract_html(url: &str, html: &str) -> String {
    // Readability with a document URL resolves relative links while parsing.
    let readability = dom_smoothie::Readability::new(html, Some(url), None)
        .ok()
        .and_then(|mut rd| {
            let title = rd.get_article_title().to_string();
            rd.parse().ok().map(|article| (title, article))
        });
    if let Some((title, article)) = readability {
        let text = article.text_content.trim();
        if text.len() >= 200 {
            let title = if title.is_empty() {
                article.title.trim()
            } else {
                title.trim()
            };
            let body = truncate_chars(text, FETCH_URL_MAX_TEXT_CHARS);
            let mut out = format!("Title: {title}\nURL: {url}\n");
            if let Some(byline) = article.byline.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                out.push_str(&format!("Byline: {byline}\n"));
            }
            if let Some(published) = article
                .published_time
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                out.push_str(&format!("Published: {published}\n"));
            }
            out.push_str(&format!("\n{body}"));
            return out;
        }
    }
    // Readability found no article (or too little text) — strip tags instead
    // so index/list/app pages still surface something usable.
    let title = extract_title(html);
    let text = html_to_text(html);
    let body = truncate_chars(&text, FETCH_URL_MAX_TEXT_CHARS);
    format!("Title: {title}\nURL: {url}\n\n{body}")
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


/// One organic search result. `pub(crate)` so the fallback engines (the
/// in-app browser SERP in `serp_browser.rs`) can produce hits and the
/// dispatch layer can merge engines' outputs.
#[derive(Debug, Clone)]
pub(crate) struct SearchHit {
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) snippet: String,
}

/// A BYO-key search provider the user configured in Settings. When set, it
/// replaces the keyless SERP engines (DDG/Mojeek) as the web index; Wikipedia
/// still supplements. Keys live in `app_settings` (`search.<provider>_key`),
/// set through the existing generic settings IPC.
#[derive(Debug, Clone)]
pub struct SearchProvider {
    /// Static provider id ("serper" | "tavily" | "brave") — doubles as the
    /// engine tag used for cache-exclusion decisions.
    pub name: &'static str,
    pub key: String,
}

/// Resolve the configured search provider from app_settings, if any.
pub(crate) fn configured_provider(conn: &rusqlite::Connection) -> Option<SearchProvider> {
    let provider = crate::db::get_setting(conn, "search.provider")
        .ok()
        .flatten()
        .unwrap_or_default();
    let provider = provider.trim().to_ascii_lowercase();
    let known = match provider.as_str() {
        "serper" => "serper",
        "tavily" => "tavily",
        "brave" => "brave",
        _ => return None,
    };
    let key = crate::db::get_setting(conn, &format!("search.{known}_key"))
        .ok()
        .flatten()
        .unwrap_or_default();
    let key = key.trim().to_string();
    if key.is_empty() {
        return None;
    }
    Some(SearchProvider { name: known, key })
}

/// Free, no-API-key web search across multiple engines: the DuckDuckGo HTML
/// results page (a *real* SERP), Mojeek's independent index, and Wikipedia's
/// API. No engine is load-bearing: any one can fail (rate-limit, layout
/// change) and the merged result stays useful. (The old DDG Instant Answer
/// API call was removed — verified live 2026-09 to return HTTP 200 with
/// empty payloads, i.e. unmaintained legacy that only masked real outages
/// as "No results found".)
///
/// Results are merged, de-duplicated by URL, and rendered as a plain-text
/// list for the model, with a per-engine health footer so the model can
/// distinguish "no public results" from "the search backend was unreachable":
/// if *every* engine errored, we return an explicit `Err` instead.
pub(super) async fn web_search(client: &reqwest::Client, query: &str) -> Result<String, String> {
    web_search_with_status(client, query, None)
        .await
        .map(|outcome| outcome.text)
}

/// Full outcome of one `web_search` execution. Carries the rendered text and
/// engine-health tag the tool always produced, PLUS the raw hits and the
/// per-engine status lines so the dispatch layer can escalate degraded
/// searches (bot-walled SERPs) to the in-app-browser / reader fallbacks and
/// re-render with the merged engine list.
#[derive(Debug, Clone)]
pub(crate) struct SearchOutcome {
    pub(crate) text: String,
    /// Machine-readable per-engine tag ("duckduckgo:ok,mojeek:fail") used by
    /// the cache layer's storage-restriction decisions.
    pub(crate) tag: String,
    pub(crate) hits: Vec<SearchHit>,
    pub(crate) engine_status: Vec<String>,
    pub(crate) engine_tag: Vec<String>,
    /// True when the SERP-grade engines produced NO organic web results —
    /// every keyless engine failed (bot wall / network) or returned zero
    /// hits. Wikipedia-only output counts: the caller should escalate rather
    /// than hand the model an encyclopedia-only answer as if it were "the
    /// web's results".
    pub(crate) serp_degraded: bool,
}

/// True when `url` is one of the SERP hosts themselves (or an in-site path of
/// one) rather than an organic result. Used to compute `serp_degraded` and to
/// filter browser-side extraction.
pub(crate) fn is_serp_host(url: &str) -> bool {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    let host = host.to_ascii_lowercase();
    host == "duckduckgo.com"
        || host.ends_with(".duckduckgo.com")
        || host == "mojeek.com"
        || host.ends_with(".mojeek.com")
}

/// True when `url` is one of the free encyclopedic *supplement* engines.
/// Wikipedia hits are useful but never proof that general web search worked —
/// a wikipedia-only result set is a degraded SERP.
fn is_supplement_host(url: &str) -> bool {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    let host = host.to_ascii_lowercase();
    host == "wikipedia.org" || host.ends_with(".wikipedia.org")
}

/// Render a merged result set + engine health list into the tool text.
/// Shared by `web_search_with_status` and the dispatch-layer fallbacks so
/// every path produces the same envelope ("Search results for …", health
/// footer) with a fetched-today date line that grounds the model's recency
/// reasoning AFTER it sees the data, not just in the system prompt.
pub(crate) fn render_search_results(
    query: &str,
    mut hits: Vec<SearchHit>,
    engine_status: Vec<String>,
    engine_tag: Vec<String>,
) -> SearchOutcome {
    // De-duplicate by URL, preserving order.
    let mut seen = std::collections::HashSet::new();
    hits.retain(|h| !h.url.is_empty() && seen.insert(h.url.clone()));

    let engines_ok = engine_tag.iter().filter(|t| t.ends_with(":ok")).count() as u32;
    let engines_tried = engine_tag.len() as u32;
    let serp_degraded = !hits
        .iter()
        .any(|h| !is_serp_host(&h.url) && !is_supplement_host(&h.url));

    let text = if hits.is_empty() {
        if engines_ok == 0 {
            // Every engine failed with a network/HTTP error — NOT "no
            // results"; the caller surfaces this as an error so the model
            // reports an outage instead of claiming the query has no results.
            return SearchOutcome {
                text: String::new(),
                tag: engine_tag.join(","),
                hits,
                engine_status,
                engine_tag,
                serp_degraded: true,
            };
        }
        format!(
            "No results found for \"{query}\". Engines: {}. Try rephrasing the query.",
            engine_status.join(", ")
        )
    } else {
        let today = chrono::Local::now().format("%Y-%m-%d");
        let mut out = format!("Live web results for \"{query}\" (fetched {today}):\n\n");
        for (i, h) in hits.iter().take(8).enumerate() {
            out.push_str(&format!("{}. {} — {}\n", i + 1, h.title, h.url));
            if !h.snippet.is_empty() {
                out.push_str(&format!("   {}\n", h.snippet));
            }
        }
        if engines_ok < engines_tried {
            out.push_str(&format!(
                "\n(engine health: {} — degraded results, treat coverage as partial)\n",
                engine_status.join(", ")
            ));
        }
        out
    };

    SearchOutcome {
        text,
        tag: engine_tag.join(","),
        hits,
        engine_status,
        engine_tag,
        serp_degraded,
    }
}

/// Same as [`web_search`] but also returns the full [`SearchOutcome`] (raw
/// hits + per-engine status) so the caching layer can persist the payload and
/// the dispatch layer can escalate bot-walled searches.
pub(crate) async fn web_search_with_status(
    client: &reqwest::Client,
    query: &str,
    provider: Option<&SearchProvider>,
) -> Result<SearchOutcome, String> {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut engine_status: Vec<String> = Vec::new();
    let mut engine_tag: Vec<String> = Vec::new();

    macro_rules! run_engine {
        ($name:literal, $fut:expr) => {{
            match $fut.await {
                Ok(mut v) => {
                    let n = v.len();
                    hits.append(&mut v);
                    engine_status.push(format!("{} ok ({n})", $name));
                    engine_tag.push(format!("{}:ok", $name));
                }
                Err(e) => {
                    engine_status.push(format!("{} FAILED: {e}", $name));
                    engine_tag.push(format!("{}:fail", $name));
                }
            }
        }};
    }

    // BYO-key provider replaces the keyless SERP engines when configured;
    // Wikipedia stays as a free encyclopedic supplement either way.
    match provider {
        Some(p) => match p.name {
            "tavily" => run_engine!("tavily", tavily_search(client, &p.key, query)),
            "brave" => run_engine!("brave", brave_search(client, &p.key, query)),
            _ => run_engine!("serper", serper_search(client, &p.key, query)),
        },
        None => {
            run_engine!("duckduckgo", duckduckgo_html(client, query));
            run_engine!("mojeek", mojeek_html(client, query));
        }
    }
    run_engine!("wikipedia", wikipedia_search(client, query));

    let outcome = render_search_results(query, hits, engine_status, engine_tag);
    if outcome.text.is_empty() {
        // The "every engine failed" sentinel from the renderer.
        return Err(format!(
            "all search engines failed: {}",
            outcome.engine_status.join("; ")
        ));
    }
    Ok(outcome)
}

/// Percent-encode a query string for use as a single URL query value
/// (RFC 3986 unreserved characters pass through, everything else is %XX'd).
/// Used to build SERP URLs for the reader/browser fallbacks.
pub(crate) fn percent_encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Keyless SERP fallback through the Jina Reader (`r.jina.ai`): the reader
/// fetches the DuckDuckGo HTML SERP from its own infrastructure with a real
/// headless browser, so a local IP that's bot-walled still gets results. The
/// reader emits markdown; organic links survive as `[title](url)` pairs (URLs
/// still DDG-wrapped, unwrapped by [`unwrap_ddg_redirect`]). Reuses the same
/// 20 RPM keyless budget as `fetch_url`'s reader fallback.
pub(crate) async fn serp_via_reader(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<SearchHit>, String> {
    if !jina_rate_limit_ok() {
        return Err(
            "jina reader rate limit reached (20 req/min keyless); retry in a minute."
                .to_string(),
        );
    }
    let target = format!(
        "https://html.duckduckgo.com/html/?q={}",
        percent_encode_query(query)
    );
    let reader_url = format!("https://r.jina.ai/{target}");
    let resp = client
        .get(&reader_url)
        .header("User-Agent", BROWSER_UA)
        .header("Accept", "text/plain")
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(|e| format!("jina reader request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("jina reader returned HTTP {status}"));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if body.trim().is_empty() {
        return Err("jina reader returned an empty document".to_string());
    }
    let hits = parse_markdown_links(&body);
    if hits.is_empty() {
        return Err("jina reader SERP yielded no organic links".to_string());
    }
    Ok(hits)
}

/// Extract organic hits from the reader's markdown output: a scan for
/// `[title](url)` pairs, keeping http(s) targets that resolve to a non-SERP
/// URL after DDG-redirect unwrapping. Image links (`![alt](src)`) are skipped.
fn parse_markdown_links(body: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while let Some(rel) = body[i..].find("](") {
        let url_start = i + rel + 2;
        let Some(url_end_rel) = body[url_start..].find(')') else {
            i = url_start;
            continue;
        };
        let url_end = url_start + url_end_rel;
        // Title: walk back from `](` to the matching opening `[`.
        let Some(title_rel) = body[..i + rel].rfind('[') else {
            i = url_end;
            continue;
        };
        let title = strip_html(&body[title_rel + 1..i + rel]);
        // A `)` inside the URL would have ended the scan earlier; images
        // `![alt](src)` carry a `!` prefix — skip those.
        let is_image = title_rel > 0 && bytes[title_rel - 1] == b'!';
        let raw_url = body[url_start..url_end].trim();
        i = url_end;
        if is_image || title.trim().is_empty() {
            continue;
        }
        let url = unwrap_ddg_redirect(raw_url);
        if !(url.starts_with("http://") || url.starts_with("https://")) || is_serp_host(&url) {
            continue;
        }
        if seen.insert(url.clone()) {
            hits.push(SearchHit {
                title: title.trim().to_string(),
                url,
                snippet: String::new(),
            });
        }
        if hits.len() >= 8 {
            break;
        }
    }
    hits
}

// ---------------------------------------------------------------------------
// BYO-key search providers
// ---------------------------------------------------------------------------

/// Serper.dev: Google SERP, $1/1k queries. POST JSON, `X-API-KEY` header.
async fn serper_search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
) -> Result<Vec<SearchHit>, String> {
    let resp = client
        .post("https://google.serper.dev/search")
        .header("X-API-KEY", key)
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .json(&serde_json::json!({ "q": query }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    if let Some(organic) = json.get("organic").and_then(|v| v.as_array()) {
        for r in organic {
            let url = r.get("link").and_then(|v| v.as_str()).unwrap_or("");
            let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
            if url.is_empty() || title.is_empty() {
                continue;
            }
            hits.push(SearchHit {
                title: title.to_string(),
                url: url.to_string(),
                snippet: r
                    .get("snippet")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            });
        }
    }
    Ok(hits)
}

/// Tavily: agent-native search, $8/1k basic credits. POST JSON, `api_key` in
/// the body (their documented v1 auth shape).
async fn tavily_search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
) -> Result<Vec<SearchHit>, String> {
    let resp = client
        .post("https://api.tavily.com/search")
        .timeout(std::time::Duration::from_secs(20))
        .json(&serde_json::json!({
            "api_key": key,
            "query": query,
            "search_depth": "basic",
            "max_results": 8
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    if let Some(results) = json.get("results").and_then(|v| v.as_array()) {
        for r in results {
            let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
            if url.is_empty() || title.is_empty() {
                continue;
            }
            hits.push(SearchHit {
                title: title.to_string(),
                url: url.to_string(),
                snippet: r
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            });
        }
    }
    Ok(hits)
}

/// Brave Search API: independent index, metered (~$5/mo effective at hobby
/// scale). GET with `X-Subscription-Token`. NOTE: Brave's terms restrict
/// result storage — `cacheable_engines` refuses to persist brave-only
/// payloads, so the cache layer stays compliant.
async fn brave_search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
) -> Result<Vec<SearchHit>, String> {
    let resp = client
        .get("https://api.search.brave.com/res/v1/web/search")
        .header("X-Subscription-Token", key)
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .query(&[("q", query), ("count", "8")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    if let Some(results) = json
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(|v| v.as_array())
    {
        for r in results {
            let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
            if url.is_empty() || title.is_empty() {
                continue;
            }
            hits.push(SearchHit {
                title: title.to_string(),
                url: url.to_string(),
                snippet: r
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            });
        }
    }
    Ok(hits)
}

/// Marker heuristics for "this HTTP-200 SERP body is actually an anti-bot
/// block page": CAPTCHA challenges, Cloudflare interstitials, anomaly
/// warnings. Only consulted when the parser found ZERO results — a genuine
/// SERP *about* captchas must not be misread as a block page, but a blocked
/// page has no result anchors to parse, so the empty-parse guard keeps this
/// precise. Reporting the block as an engine FAILURE (instead of the
/// `ok (0 results)` the empty parse used to produce) is what lets the caller
/// distinguish "no public results" from "we're being bot-walled" and engage
/// the browser/reader fallbacks.
fn serp_page_blocked(body: &str) -> bool {
    const MARKERS: &[&str] = &[
        "captcha",
        "anomaly", // DuckDuckGo's block page wording
        "unusual traffic",
        "are you a robot",
        "verify you are human",
        "just a moment", // Cloudflare JS challenge
        "cf-challenge",
        "attention required",           // Cloudflare block
        "enable javascript and cookies", // Cloudflare / PerimeterX wording
    ];
    let lower = body.to_ascii_lowercase();
    MARKERS.iter().any(|m| lower.contains(m))
}

/// The DuckDuckGo **HTML** results endpoint (`html.duckduckgo.com/html/`) is a
/// real search-engine results page — unlike the Instant Answer API, it returns
/// organic web results for *any* query, not just known entities. We POST the
/// query (the form's own method — GETs on this endpoint are the first thing
/// its rate limiter throttles) with a browser User-Agent and parse the result
/// anchors out of the (small, stable) HTML the endpoint emits. This is the
/// keyless primary search source.
async fn duckduckgo_html(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<SearchHit>, String> {
    let url = "https://html.duckduckgo.com/html/";
    let resp = client
        .post(url)
        .header("User-Agent", BROWSER_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .timeout(std::time::Duration::from_secs(10))
        .form(&[("q", query)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    finish_serp_parse(parse_duckduckgo_html(&body), &body)
}

/// Shared tail of the keyless SERP fetchers: convert a parsed result set into
/// the engine outcome, flagging anti-bot block pages as failures. See
/// [`serp_page_blocked`] for why the check only fires on an empty parse.
fn finish_serp_parse(hits: Vec<SearchHit>, body: &str) -> Result<Vec<SearchHit>, String> {
    if hits.is_empty() && serp_page_blocked(body) {
        return Err(
            "blocked by an anti-bot challenge (CAPTCHA/anomaly page) — this is an \
             engine block, not an empty result set"
                .to_string(),
        );
    }
    Ok(hits)
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
/// real URL; otherwise return the href unchanged. `pub(crate)`: the
/// browser-pane SERP fallback extracts wrapped anchors too.
pub(crate) fn unwrap_ddg_redirect(href: &str) -> String {
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

/// Mojeek is the keyless fallback index: an independent crawler (not a Bing/DDG
/// reskin), stable HTML, no bot-wall — queried so a DDG layout change or rate
/// limit can no longer take search down by itself.
async fn mojeek_html(client: &reqwest::Client, query: &str) -> Result<Vec<SearchHit>, String> {
    let url = "https://www.mojeek.com/search";
    let resp = client
        .get(url)
        .header("User-Agent", BROWSER_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
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
    finish_serp_parse(parse_mojeek_html(&body), &body)
}

/// Parse the Mojeek results page. Results are `<li>` blocks whose title link
/// is an `<a href="http…">Title</a>` (historically inside an `<h2>`) with a
/// sibling `<p class="s">` snippet. Parsed tolerantly (block-slice + first
/// external anchor rather than exact class chains) so minor markup tweaks
/// degrade instead of zeroing the engine.
fn parse_mojeek_html(html: &str) -> Vec<SearchHit> {
    let lower = html.to_ascii_lowercase();
    let mut hits = Vec::new();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find("<li") {
        let li_start = search_from + rel;
        // Skip `<li`-prefixed tags like `<link`.
        let after = lower[li_start + 3..].chars().next();
        if !matches!(after, Some(' ') | Some('>') | Some('\t') | Some('\n') | Some('\r')) {
            search_from = li_start + 3;
            continue;
        }
        let li_end_rel = match lower[li_start..].find("</li>") {
            Some(e) => e,
            None => break,
        };
        let li_end = li_start + li_end_rel;
        search_from = li_end + 5;
        let block = &html[li_start..li_end];
        let block_lower = &lower[li_start..li_end];

        // First anchor with an external http(s) href is the result link.
        let mut href: Option<(String, usize)> = None;
        let mut scan = 0;
        while let Some(a_rel) = block_lower[scan..].find("<a ") {
            let a_pos = scan + a_rel;
            let close_gt = match block_lower[a_pos..].find('>') {
                Some(g) => a_pos + g,
                None => break,
            };
            let open_tag = &block[a_pos..=close_gt.min(block.len() - 1)];
            if let Some(raw_href) = extract_attr(open_tag, "href") {
                if raw_href.starts_with("http://") || raw_href.starts_with("https://") {
                    href = Some((raw_href, close_gt + 1));
                    break;
                }
            }
            scan = close_gt + 1;
        }
        let Some((url, text_start)) = href else { continue };
        let title_end = match block_lower[text_start..].find("</a>") {
            Some(e) => text_start + e,
            None => continue,
        };
        let title = strip_html(&block[text_start..title_end]);
        if title.is_empty() {
            continue;
        }
        // Snippet: first `<p class="s">` in the block; fall back to any `<p>`.
        let snippet = find_tag_text(block, block_lower, "p", Some("s"))
            .or_else(|| find_tag_text(block, block_lower, "p", None))
            .unwrap_or_default();
        hits.push(SearchHit {
            title,
            url,
            snippet,
        });
    }
    hits
}

/// Text content of the first `<tag>` (optionally restricted to a `class`
/// value) inside `block`. `block_lower` is the ASCII-lowercased twin of
/// `block` (same byte offsets).
fn find_tag_text(block: &str, block_lower: &str, tag: &str, class: Option<&str>) -> Option<String> {
    let mut scan = 0;
    while let Some(t_rel) = block_lower[scan..].find(&format!("<{tag}")) {
        let t_pos = scan + t_rel;
        let after = match block_lower[t_pos + tag.len() + 1..].chars().next() {
            Some(c) => c,
            None => return None,
        };
        if !matches!(after, ' ' | '>') {
            scan = t_pos + tag.len();
            continue;
        }
        let close_gt = block_lower[t_pos..].find('>')? + t_pos;
        let open_tag = &block[t_pos..=close_gt.min(block.len() - 1)];
        let class_ok = match class {
            None => true,
            Some(want) => extract_attr(open_tag, "class")
                .is_some_and(|c| c.split_whitespace().any(|w| w == want)),
        };
        let text_start = close_gt + 1;
        let text_end_rel = block_lower[text_start..].find(&format!("</{tag}>"))?;
        if class_ok {
            return Some(strip_html(&block[text_start..text_start + text_end_rel]));
        }
        scan = text_start + text_end_rel;
    }
    None
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
    fn serp_block_pages_are_detected_only_on_empty_parses() {
        // A challenge page with no result anchors reads as blocked...
        let wall = "<html><body>Unfortunately, our systems detected an anomaly. \
                    Please verify you are human to continue.</body></html>";
        assert!(serp_page_blocked(wall));
        assert!(finish_serp_parse(Vec::new(), wall).is_err());
        // ...while a genuine SERP that happens to DISCUSS captchas (and
        // therefore parses to hits) must never be misread as a block page.
        let legit = concat!(
            r#"<a class="result__a" href="https://example.org/captcha-guide">"#,
            r#"How CAPTCHAs work</a>"#
        );
        let hits = parse_duckduckgo_html(legit);
        assert_eq!(hits.len(), 1);
        assert!(finish_serp_parse(hits, legit).is_ok());
        // A genuinely empty, non-blocked page stays "ok (0 results)".
        assert!(finish_serp_parse(Vec::new(), "<html><body></body></html>").is_ok());
    }

    #[test]
    fn percent_encode_query_keeps_unreserved_and_escapes_the_rest() {
        assert_eq!(percent_encode_query("rust 2026 &async?"), "rust%202026%20%26async%3F");
        assert_eq!(percent_encode_query("plain-words_1.0~a"), "plain-words_1.0~a");
    }

    #[test]
    fn render_results_flags_serp_degraded_on_wikipedia_only_output() {
        let wiki_only = vec![SearchHit {
            title: "Rust (programming language)".into(),
            url: "https://en.wikipedia.org/wiki/Rust_(programming_language)".into(),
            snippet: String::new(),
        }];
        let status = vec!["duckduckgo FAILED: HTTP 403".to_string()];
        let tag = vec!["duckduckgo:fail".to_string()];
        let outcome = render_search_results("rust", wiki_only, status, tag);
        assert!(outcome.serp_degraded, "wikipedia-only output is degraded");
        assert!(outcome.text.contains("Live web results"));
        assert!(outcome.text.contains("(fetched "), "date line present");
        assert!(outcome.text.contains("engine health"));
    }

    #[test]
    fn render_results_not_degraded_when_organic_hits_exist() {
        let hits = vec![SearchHit {
            title: "Rust".into(),
            url: "https://www.rust-lang.org/".into(),
            snippet: String::new(),
        }];
        let status = vec!["duckduckgo ok (1)".to_string()];
        let tag = vec!["duckduckgo:ok".to_string()];
        let outcome = render_search_results("rust", hits, status, tag);
        assert!(!outcome.serp_degraded);
        assert_eq!(outcome.tag, "duckduckgo:ok");
    }

    #[test]
    fn parse_markdown_links_extracts_reader_serp_hits() {
        let md = concat!(
            "Title: rust\n\n",
            "Markdown Content:\n\n",
            "- [Rust Programming Language](https://www.rust-lang.org/)\n",
            "- [wrapped result](//duckduckgo.com/l/?uddg=https%3A%2F%2Fdoc.rust-lang.org%2F&q=1)\n",
            "- [DDG home](https://duckduckgo.com/about) — SERP host, skipped\n",
            "![banner](https://img.example.org/banner.png) image, skipped\n",
            "- [relative](/only/relative) skipped\n",
        );
        let hits = parse_markdown_links(md);
        assert_eq!(hits.len(), 2, "organic + wrapped kept; host/image/relative skipped");
        assert_eq!(hits[0].url, "https://www.rust-lang.org/");
        assert_eq!(hits[1].url, "https://doc.rust-lang.org/", "uddg unwrapped");
    }

    #[test]
    fn serp_host_detection_covers_ddg_and_mojeek() {
        assert!(is_serp_host("https://duckduckgo.com/l/?uddg=x"));
        assert!(is_serp_host("https://html.duckduckgo.com/html/"));
        assert!(is_serp_host("https://www.mojeek.com/search?q=x"));
        assert!(!is_serp_host("https://www.rust-lang.org/"));
    }

    #[test]
    fn host_blocked_always_blocks_literal_private_and_loopback_ips() {
        // Deterministic regardless of proxy env: the SSRF shapes that matter
        // (literal loopback / LAN / metadata addresses) are blocked by name
        // before any DNS is consulted. Public literals stay allowed.
        for host in ["127.0.0.1", "10.0.0.5", "192.168.1.10", "172.16.0.1",
                     "169.254.169.254", "100.64.0.1", "::1", "[::ffff:127.0.0.1]"] {
            assert!(host_blocked(host), "{host} must be blocked");
        }
        assert!(!host_blocked("93.184.216.34"));
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
    fn parse_mojeek_html_extracts_results_tolerantly() {
        // Fixture shaped like Mojeek's SERP: <li> blocks with an <h2><a href>
        // title link and a <p class="s"> snippet. Exercises both the exact
        // shape and a variant with the anchor outside the <h2>.
        let html = concat!(
            r#"<ul class="results-standard"><li><h2><a href="https://www.rust-lang.org/">Rust Programming Language</a></h2>"#,
            r#"<p class="s">A language empowering everyone to build reliable software.</p></li>"#,
            r#"<li><h2><a class="title" href="https://doc.rust-lang.org/book/">The Rust Book</a></h2>"#,
            r#"<p class="s">Learn Rust — the official book.</p></li>"#,
            r#"<li><a href="/internal">internal link is skipped</a></li>"#,
            r#"<li><p class="s">no anchor here</p></li>"#,
            r#"</ul>"#,
        );
        let hits = parse_mojeek_html(html);
        assert_eq!(hits.len(), 2, "external-anchor results parsed, others skipped");
        assert_eq!(hits[0].url, "https://www.rust-lang.org/");
        assert_eq!(hits[0].title, "Rust Programming Language");
        assert_eq!(
            hits[0].snippet,
            "A language empowering everyone to build reliable software."
        );
        assert_eq!(hits[1].url, "https://doc.rust-lang.org/book/");
        assert_eq!(hits[1].title, "The Rust Book");
    }

    #[test]
    fn truncate_chars_cuts_on_char_boundary() {
        assert_eq!(truncate_chars("hello", 10), "hello");
        let cut = truncate_chars("abcdef", 3);
        assert!(cut.starts_with("abc"));
        assert!(cut.contains("truncated"));
        // Multibyte: must not panic slicing inside a char.
        let _ = truncate_chars("héllo wörld", 4);
    }

    #[test]
    fn is_probable_pdf_url_checks_path_only() {
        assert!(is_probable_pdf_url("https://x.org/report.pdf"));
        assert!(is_probable_pdf_url("https://x.org/report.PDF?dl=1"));
        assert!(!is_probable_pdf_url("https://x.org/pdf.html"));
        assert!(!is_probable_pdf_url("https://x.org/page?q=.pdf"));
    }

    #[test]
    fn jina_rate_limiter_windows() {
        // Fresh limiter: below the cap, every hit allowed.
        for _ in 0..4 {
            assert!(jina_rate_limit_ok());
        }
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

    #[test]
    fn ssrf_guard_resolves_plain_hostnames() {
        // Regression: the resolver used the bare-&str ToSocketAddrs impl,
        // which requires `host:port` and ERRORS on every plain hostname —
        // with the fail-closed `Err => true` that refused EVERY domain and
        // turned fetch_url into a hard wall. "localhost" resolves via the
        // hosts file to loopback: the blocked verdict must come from the IP
        // check (resolution succeeding), not from a resolution error.
        // Pinned on the NON-proxied path: the test process inherits the
        // user's shell env (HTTP_PROXY etc.), where hostname resolution is
        // skipped by design.
        assert!(host_blocked_in("localhost", false));
        // RFC 2606 `.invalid` is guaranteed unresolvable → fail-closed true.
        assert!(host_blocked_in("relay-does-not-exist.invalid", false));
        // Proxied path: hostname checks are skipped (the proxy resolves),
        // literal IPs are still judged.
        assert!(!host_blocked_in("example.com", true));
        assert!(host_blocked_in("127.0.0.1", true));
    }

}
