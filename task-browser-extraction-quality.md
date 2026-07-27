# Task: Upgrade Browser Pane Tools to Structured, Clean Extraction

## Context

Chat tab already has `browser_read`, `browser_click`, `browser_type`, `browser_scroll` (per `AI_CONTEXT.md`). This task upgrades the extraction quality of `browser_read` specifically, and hardens navigation against the real-world page conditions that break naive DOM reads (consent banners, lazy-loaded/infinite-scroll content, JS-rendered SPAs that aren't settled yet). This is the mechanical/infrastructure half of the browser-research upgrade — see the companion task for the orchestration/prompting half.

This approach is DOM-grounded (JS injected into the existing webview via Tauri's `eval`), not screenshot/vision-based and not CDP-based — this works identically across WebView2 (Windows), WKWebView (macOS), and WebKitGTK (Linux) since it's just JS execution inside whatever webview already renders the pane, sidestepping the CDP/WKWebView limitation noted earlier for the Dev-tab browser-control design. If the current `browser_read` implementation is screenshot/vision-based or CDP-based, this task supersedes it — confirm current implementation in `browser.rs`/equivalent before starting so the right thing gets replaced vs. extended.

## What to build

### 1. Content-extraction JS bridge (new script injected via webview `eval`, e.g. `bridge/extract.js`, loaded into the pane on read requests)

- Port a readability-style extraction algorithm (same family of approach as Firefox Reader Mode / Mozilla's `readability.js` — vendoring that library directly is a reasonable starting point rather than writing extraction heuristics from scratch) to identify and return main article content, stripped of navigation, ads, footers, and other boilerplate.
- Output format: clean Markdown (headings, paragraphs, lists, tables preserved in structure) — not raw HTML, not a flat text dump. This is what gets returned to the model as the `browser_read` tool result.
- Also extract and return separately: page title, canonical URL, and (if present) a publish/updated date — these feed the source-ledger tool in the companion task.

### 2. Pre-extraction page hardening

Run before extraction, as part of the same `browser_read` call:
- **Consent/cookie banner dismissal**: detect common patterns (fixed-position overlay elements containing typical consent-banner text/button patterns — "Accept", "I agree", "Accept all cookies") and click-dismiss automatically before extracting, so the model doesn't read banner text as page content.
- **Settle wait for JS-rendered content**: after navigation, wait for network-idle or a short fixed settle period (start with something like 800ms–1.5s, make it configurable) before running extraction, to avoid capturing a loading skeleton on SPA-heavy pages.
- **Lazy-load / infinite-scroll handling**: for `browser_read` calls where initial extracted content looks unusually short relative to page height, perform a bounded scroll-and-wait loop (e.g. up to 3-5 scroll steps with a short wait between each) before re-extracting, to surface content that only renders on scroll. Cap this — don't scroll indefinitely on a genuinely infinite feed.

### 3. Read-mode variants (extend `browser_read`'s parameters, not new tools)

```
browser_read(mode: "full" | "summary_only" | "section", selector?: string) -> ExtractedContent
```
- `full`: complete cleaned extraction (current default behavior, upgraded per §1-2).
- `summary_only`: return just title + headings structure + first N characters of body — for the model to decide if a full read is warranted before spending the tokens (this directly supports the context-budget discipline from the research-orchestration task).
- `section`: extract only the content under a given heading/selector, for long pages where only part is relevant.

### 4. Extraction failure handling

- If readability-style extraction produces suspiciously little content (e.g. below a length threshold) or the page appears to require login/is a paywall, return a structured failure reason (`"paywalled"`, `"login_required"`, `"extraction_failed"`, `"blocked"`) rather than an empty or garbage result — so the model can decide to skip the source, try an alternate URL, or flag it as unavailable in its final synthesis rather than silently treating empty content as "nothing relevant here."

## Acceptance criteria

- [ ] `browser_read` returns clean Markdown via the readability-style bridge, verified against at least 5 real-world pages of different types (a news article, a docs page, a Wikipedia-style page, a JS-heavy SPA, a page with a cookie consent banner) — confirm boilerplate is stripped and main content is intact for each.
- [ ] Consent banners are auto-dismissed before extraction on a page with a known common banner pattern (test against at least 2 real sites with different banner implementations).
- [ ] Extraction on a JS-rendered SPA captures real content, not a loading skeleton — verified against a real client-rendered page.
- [ ] Lazy-load/scroll handling surfaces below-the-fold content on a page that requires scrolling to render it, without scrolling indefinitely on infinite-feed pages.
- [ ] `summary_only` and `section` modes work correctly and return meaningfully smaller payloads than `full` mode.
- [ ] Failure cases (paywall, login-required, extraction-failed) return structured reasons, not silent empty results — verified against at least one real paywalled page.
- [ ] Regression check: `browser_click`, `browser_type`, `browser_scroll` still function correctly — this task touches the same webview bridge infrastructure.

## Out of scope for this task

- Source ledger, query decomposition, synthesis/verification prompting — see the companion orchestration task.
- Any change to the Dev-tab agent-browser-control design from the earlier diagram/testing task, though this JS-bridge approach should be flagged as a better pattern worth retrofitting there too (note in `BUILD_LOG.md`, don't scope the actual retrofit into this task).

## Process reminder

Per PRD §13: test extraction quality against real, varied pages manually (automated tests can't fully substitute for this — website structures vary too much), log which real pages were used as the manual test set in `BUILD_LOG.md`, and update `AI_CONTEXT.md`'s tool descriptions for `browser_read`'s new mode parameter.
