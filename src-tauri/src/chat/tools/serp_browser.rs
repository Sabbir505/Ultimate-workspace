//! Keyless SERP fallback executed inside the app's OWN browser pane.
//!
//! When the direct HTTP scrape of the search engines is bot-walled (CAPTCHA /
//! 403 — the walls key off non-browser TLS + header fingerprints that plain
//! `reqwest` cannot fake), the same SERP is loaded in a real WebView: full
//! browser fingerprint, cookies, and JS, which the challenge pages treat as a
//! genuine visitor. The pane machinery is the same one the `open_url` /
//! `browser_*` chat tools drive, so the trust layer (user pause/stop) applies
//! unchanged.
//!
//! Lifecycle: when a browser pane is already open, the sweep runs in a
//! THROWAWAY tab that is closed again afterwards (background research — if
//! the user should SEE a page, the model calls `open_url`, which is the
//! existing "show the user" contract). When no pane exists, one is opened and
//! left on the SERP: the pane is frontend-owned, so tearing it down from the
//! backend would strand the UI half-closed, and "the agent searched here" is
//! honest information for the user anyway.

use tauri::{AppHandle, Emitter, Manager};

use super::search::{is_serp_host, percent_encode_query, unwrap_ddg_redirect, SearchHit};
use crate::browser::BrowserManager;

/// Synthetic project id for auto-opened search panes. Only used for pane
/// bookkeeping (the frontend resolves panes by project id for MCP ops); a
/// reserved sentinel keeps the sweep from being mistaken for a project's
/// agent browser session.
const SEARCH_PANE_PROJECT: &str = "__relay_search__";

/// JS: poll for SERP result anchors, bounded (~12s). Returns "ready" once the
/// results are in the DOM, "not-found" after the budget — a challenge page
/// (or a layout change) stays "not-found" and the sweep moves on.
const SERP_WAIT_JS: &str = r#"
return (async () => {
  for (var i = 0; i < 48; i++) {
    if (document.querySelector('.result__a, .results-standard a, li h2 a')) return 'ready';
    await new Promise(function (r) { setTimeout(r, 250); });
  }
  return 'not-found';
})()
"#;

/// JS: collect organic result anchors (title \t url per line). Selector-
/// tolerant: DDG's `result__a` anchors, Mojeek's `h2 > a` / `.results-standard`
/// blocks. hrefs arrive ABSOLUTE (the browser resolves them), so DDG's
/// `duckduckgo.com/l/?uddg=…` wrappers come back intact for the Rust side to
/// unwrap. Capped at 14 rows.
const SERP_EXTRACT_JS: &str = r#"
var out = [];
var seen = {};
document.querySelectorAll('a').forEach(function (a) {
  var h = a.href || '';
  if (!/^https?:/i.test(h)) return;
  var cls = a.className || '';
  var inResult = /\bresult__a\b/.test(cls) || a.closest('.results-standard') || a.closest('h2');
  if (!inResult) return;
  var t = (a.textContent || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 2 || seen[h]) return;
  seen[h] = 1;
  out.push(t + '\t' + h);
});
return out.slice(0, 14).join('\n');
"#;

/// Parse the `title\turl` extraction into organic hits: unwrap DDG redirects,
/// drop SERP-host self-links, de-duplicate.
fn parse_extraction(raw: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in raw.lines() {
        let Some((title, url)) = line.split_once('\t') else {
            continue;
        };
        let url = unwrap_ddg_redirect(url.trim());
        if !(url.starts_with("http://") || url.starts_with("https://")) || is_serp_host(&url) {
            continue;
        }
        let title = title.trim();
        if title.is_empty() {
            continue;
        }
        if seen.insert(url.clone()) {
            hits.push(SearchHit {
                title: title.to_string(),
                url,
                snippet: String::new(),
            });
        }
    }
    hits
}

/// Load `url` in the pane tab (skipped when the tab was just created pointing
/// at it — the creation URL IS the first engine) and wait for SERP anchors,
/// then extract them.
async fn load_and_extract(
    mgr: &BrowserManager,
    app: &AppHandle,
    pane_id: &str,
    tab_id: &str,
    label: &str,
    url: &str,
    navigate_needed: bool,
) -> Result<Vec<SearchHit>, String> {
    if navigate_needed {
        // Windows: route through the real CoreWebView2.Navigate (tauri's
        // dispatcher drops messages for these child webviews); this also
        // arms the nav-quiesce gate the action evals wait on.
        mgr.navigate(app, pane_id, tab_id, url)?;
    }
    // Bounded wait for the SERP DOM; a challenge page stays "not-found".
    let _ = mgr.run_action_for_pane(label, SERP_WAIT_JS).await;
    let raw = mgr
        .run_action_for_pane(label, SERP_EXTRACT_JS)
        .await
        .unwrap_or_default();
    Ok(parse_extraction(&raw))
}

/// Run `query` against the keyless SERPs inside the built-in browser pane.
/// Tries DuckDuckGo's HTML endpoint first, Mojeek if the first page yields
/// nothing. The entire sweep is bounded by a 40s timeout; every failure mode
/// is an `Err` so the caller's engine-health reporting stays truthful.
pub(crate) async fn browser_serp_search(
    app: &AppHandle,
    query: &str,
) -> Result<Vec<SearchHit>, String> {
    if !crate::browser::platform_supported() {
        return Err("built-in browser pane is not supported on this platform".to_string());
    }
    let mgr = app.state::<crate::BrowserState>().0.clone();

    let sweep = async {
        let ddg_url = format!("https://html.duckduckgo.com/html/?q={}", percent_encode_query(query));

        // Host the sweep: a throwaway tab in the open pane, or a fresh pane
        // (left open — see the module doc) when none exists.
        let (pane_id, tab_id, created_tab) = match mgr.active_pane_id() {
            Some(pid) => {
                let tid = mgr
                    .new_tab_for_pane(&pid, &ddg_url)
                    .await
                    .map_err(|e| format!("browser SERP tab creation failed: {e}"))?;
                (pid, tid, true)
            }
            None => {
                let label = mgr
                    .open_pane_for_project(SEARCH_PANE_PROJECT, &ddg_url)
                    .await
                    .map_err(|e| format!("browser SERP pane creation failed: {e}"))?;
                // Label is `browser-{pane}-tab-{tab}` — split it back out.
                let (pid, tid) = label
                    .strip_prefix("browser-")
                    .and_then(|rest| rest.split_once("-tab-"))
                    .map(|(p, t)| (p.to_string(), t.to_string()))
                    .ok_or_else(|| format!("unparsable browser label: {label}"))?;
                (pid, tid, false)
            }
        };
        let label = crate::browser::browser_label(&pane_id, &tab_id);
        let _ = app.emit("browser:activity", serde_json::json!({ "pane_id": pane_id }));

        // The fresh tab / fresh pane already points at the DDG SERP; an
        // explicit navigate is only needed for the second engine.
        let first = load_and_extract(&mgr, app, &pane_id, &tab_id, &label, &ddg_url, false).await;
        let hits = match first {
            Ok(h) if !h.is_empty() => h,
            first => {
                let mojeek_url =
                    format!("https://www.mojeek.com/search?q={}", percent_encode_query(query));
                match load_and_extract(&mgr, app, &pane_id, &tab_id, &label, &mojeek_url, true)
                    .await
                {
                    Ok(h) => h,
                    Err(mojeek_err) => {
                        if created_tab {
                            let _ = mgr.close_tab_for_pane(&pane_id, &tab_id).await;
                        }
                        return Err(first.err().unwrap_or(mojeek_err));
                    }
                }
            }
        };

        if created_tab {
            // Best effort: the pane (and the user's own tabs) are untouched.
            let _ = mgr.close_tab_for_pane(&pane_id, &tab_id).await;
        }

        Ok(hits)
    };

    match tokio::time::timeout(std::time::Duration::from_secs(40), sweep).await {
        Ok(Ok(hits)) if !hits.is_empty() => Ok(hits),
        Ok(Ok(_)) => Err(
            "browser SERP yielded no organic results (challenge page or markup change)"
                .to_string(),
        ),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("browser SERP sweep timed out after 40s".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_extraction_unwraps_ddg_and_drops_serp_hosts() {
        let raw = concat!(
            "Rust Programming Language\thttps://www.rust-lang.org/\n",
            "The Rust Book\thttps://duckduckgo.com/l/?uddg=https%3A%2F%2Fdoc.rust-lang.org%2Fbook%2F&rut=abc\n",
            "DDG About\thttps://duckduckgo.com/about\n",
            "no tab separator line\n",
        );
        let hits = parse_extraction(raw);
        assert_eq!(hits.len(), 2, "organic + wrapped kept; SERP-host link dropped");
        assert_eq!(hits[0].title, "Rust Programming Language");
        assert_eq!(hits[0].url, "https://www.rust-lang.org/");
        assert_eq!(hits[1].url, "https://doc.rust-lang.org/book/");
    }

    #[test]
    fn parse_extraction_dedupes_by_url() {
        let raw = "A\thttps://example.org/\nB\thttps://example.org/\n";
        assert_eq!(parse_extraction(raw).len(), 1);
    }

    #[test]
    fn serp_wait_js_and_extract_js_are_self_contained() {
        // The JS bodies are interpolated into the action wrapper verbatim —
        // they must not close the wrapper's IIFE early or use template
        // literal/arrow syntax that the var-only style avoids. Cheap sanity:
        // no raw curly-brace escapes that would break the format! in the
        // wrapper, and both `return` their result.
        for js in [SERP_WAIT_JS, SERP_EXTRACT_JS] {
            assert!(js.contains("return"), "probe must return its result");
            assert!(!js.contains("${"), "no template placeholders expected");
        }
    }
}
