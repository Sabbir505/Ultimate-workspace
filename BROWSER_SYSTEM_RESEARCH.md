# Browser System — Deep Research & Improvement Plan

*Research date: 2026-09-03. Sources: codebase audit (frontend + Rust backend) + web research across Playwright MCP, chrome-devtools-mcp, Browser Use, Stagehand, Anthropic browser/computer-use toolsets, OpenAI Operator/Atlas, Claude in Chrome, Edge Copilot Actions, Brave, Comet, Dia, Fellou, Opera, plus 2025–26 papers and the WebView2 API surface. Full source links in the Appendix.*

> **Update (2026-09-05):** two drift items since this research — the relay sidecar binary is now `src-tauri/src/bin/relay_browser_mcp.rs` (Conduit→Relay rename, `7f6952b1`), and the §4 P0 "screenshot tool exists server-side but is unreachable from the relay binary" gap is **closed**: `screenshot` is advertised in the binary's `tools/list` (`relay_browser_mcp.rs`) with a drift-regression test in `src-tauri/src/chat/tools/specs.rs`.

---

## 1. Executive summary

Relay's embedded browser is architecturally sound — native child webviews with a working COM integration, a loopback MCP bridge with auth and anti-spoofing nonces, Readability extraction, and a watch-mode overlay are all the right primitives. But measured against where the ecosystem converged in 2025–26, the system is **one generation behind on the agent surface and missing the entire trust/permission layer for users**.

The three highest-leverage moves:

1. **Close the observation loop per action.** Every SOTA system (Playwright MCP, Anthropic's browser toolset, chrome-devtools-mcp) returns a *fresh, token-compressed a11y snapshot with each action result* (`includeSnapshot` opt-in). Our agent tools force a separate `read_page` roundtrip after nearly every click — the single biggest agent-efficiency and reliability gap. Snapshots cost ~200–400 tokens vs 3,000–5,000 for screenshots; formatting choices alone are worth 51–79% of snapshot tokens.
2. **Build the trust layer users now expect.** Autonomy dial (Manual/Auto), action-class hard gates (payments, credentials, downloads), a user-owned action timeline, and privacy-shielded credential handoff. This is what every shipped agentic browser converged on; its absence is the top reason users don't trust agent browsing. UW (June 2026): 4 of 7 agentic browsers let a malicious page bypass same-origin policy via prompt injection — the pane's real security boundary is the UX around it.
3. **Unlock the WebView2 capabilities we already pay for.** CDP event subscription (`GetDevToolsProtocolEventReceiver`), `PrintToPdf` (`ICoreWebView2_16`), `DownloadStarting`, `ICoreWebView2CookieManager`, and multi-profile isolation (`ICoreWebView2ProfileManagement`) are all reachable from our existing raw webview2-com path — no wry/tauri changes needed. They enable network/console diagnostics tools, PDF export, downloads-to-workspace, and per-project session isolation.

Also: **5 concrete bugs/dead paths to fix this week** (§4 P0), including the MCP `screenshot` tool that exists server-side but is unreachable from the relay binary.

---

## 2. Current system snapshot

### What exists (verified in code)

| Layer | Implementation |
|---|---|
| Rendering | Native child webviews: raw `webview2-com` COM on Windows (bypasses the tauri-runtime-wry dispatcher drop, `browser.rs:490–501`), tauri `add_child` on macOS, separate `WebviewWindow`s on Linux; iframe fallback with X-Frame-Options overlay |
| Tabs & panes | Multi-tab panes (`browser-{pane}-tab-{tab}` labels), lazy webview creation, occlusion via `browser_set_visible` + off-screen bounds (`browserOcclusion.ts`), LRU pane eviction, ghost-webview defenses |
| Navigation | `browser:navigated` from NavigationStarting + pushState monkey-patch + WebMessage bridge; `browser:load-completed` as ground truth; devtools, external-open |
| Agent surface | Loopback WS server on fixed `127.0.0.1:7681` (128-bit token, constant-time compare) → `browser_mcp.rs` dispatches 11 ops → `run_action_for_pane` injects promise-wrapped JS with per-action nonce; stdio relay binary `conduit-browser-mcp` advertises 10 tools; per-project `.mcp.json` registration (`browser_mcp_register.rs`) |
| Tools | navigate, read_page, click, type_text, scroll, wait_for, hover, evaluate, history, click_and_wait; targeting = CSS selector or scored text/aria match (`bridge_resolve.js`); `data-conduit-ref` tagging in `bridge_extract.js` |
| Extraction | Vendored Readability + `bridge_extract.js`: consent-banner dismissal, full/summary_only/section/interactive modes, lazy-load scroll (≤4 steps), 50k-char cap, structured failure reasons (paywalled/login_required/blocked) |
| Visual feedback | Synthetic cursor tween, click ripple, typing caret, element highlight (`bridge_overlay.js`), watch-mode pacing, `browser:activity` surfacing the pane |
| Security | WS auth token in child env only; action-result nonce anti-spoofing; `javascript:` rejected in push-state paths; `conduit_tools:*` whitelist bridge |

### What's already right (keep, don't regress)

- **DOM/a11y-first agent control with screenshots as fallback** — this matches the 2026 consensus (Anthropic: "read the tree before you screenshot"; Playwright made screenshots opt-in).
- **Refs (`data-conduit-ref`) on interactive elements** — matches Playwright/Anthropic ref models.
- **Watch-mode overlay** — the "visible agent" principle Brave/Edge validate.
- **Nonce-verified action results** — pages can't spoof tool results; most competitors don't have this.
- **Per-project MCP registration with scoped tokens.**

---

## 3. What state-of-the-art looks like (research findings)

### 3a. Agent tool design

**Playwright MCP** (~50 tools): structured a11y snapshots with `eN` refs; every interaction tool returns a fresh snapshot; `browser_find` searches the snapshot by text/regex to avoid full-snapshot cost; network requests + console messages as core tools; tabs/storage/pdf/vision-coordinates behind capability flags; coordinate tools as sanctioned fallback for canvas/video. Snapshot ≈ **200–400 tokens vs 3,000–5,000 for a screenshot**. The 2026 shift: a parallel **CLI+Skills** surface because coding agents burn ~**114K tokens per test via MCP vs 27K via CLI** — tool schemas + verbose snapshots are the cost.

**Anthropic browser toolset** (`browser_toolset_20260801`, 31 tools) — the most complete published design, and closest to what ours should become:
- `read_page` (a11y text with `[ref_N]`, `filter: interactive|all`, `depth`, subtree reads, 50k cap with truncation notice) + **`find`** ("search for elements matching a natural-language description", ≤20 tagged matches) + `get_page_text` (Readability built into the protocol — we have this).
- Union targets `{ref | coordinate}`; stale refs return an explicit *"ref_N is stale… re-read the page"* error and **refs are never renumbered within a page state**.
- `form_input` sets values **directly by ref** (checkbox booleans, select by visible text); `file_upload` allowlist-dir only; `read_console`/`read_network` incremental "since last read"; tab tools return one compact `browser_state` block; batch actions with a halt rule ("Not executed: an earlier action failed").
- Observations built from the **rendered** tree/visible text "so hidden text doesn't reach the model" — both an injection defense and a token saving.

**chrome-devtools-mcp** (~57 tools): `uid`-from-snapshot targeting; `includeSnapshot` opt-in per action; `evaluate_script` with **`waitForStableDom`** default-on (SPA settle); network list + per-request headers/bodies preserved across 3 navigations; performance traces with named insight drill-down (LCP breakdown etc.); emulation (CPU/network throttling, viewport, geolocation); Lighthouse audit incl. an "agentic browsing" category.

**Browser Use**: hybrid CDP serializer merging `Accessibility.getFullAXTree` (all frames) + `DOMSnapshot.captureSnapshot`; JS click-listener detection for interactivity (catches React/Vue/Angular handlers); shadow-root elements clickable via index markers; **zero-LLM-cost deterministic helpers** — `search_page` ("like grep") and `find_elements` (CSS query); `extract` with JSON schema + pagination; overwrite-by-default `input` (loop failure mode #1 is append-typing); `ActionLoopDetector` + `PageFingerprint`; vision `auto` mode.

**Stagehand**: three AI primitives (`act`/`extract`/`observe`) blended with deterministic Playwright code; `observe` → LLM proposes selector, code disposes; deterministic replay of recorded actions with zero inference; per-frame a11y merge across out-of-process iframes + closed shadow roots; instruction+page-keyed caching.

**Benchmarks (with skepticism)**: WebArena GPT-4 baseline 14.41% vs human 78.24%; CUA 58.1%. WebVoyager scores ~90% from vendors collapse to **30–61%** on the cleaner Online-Mind2Web ("An Illusion of Progress?", OSU). Browser Use's leap to 97% (their harness/judge) came from **giving the agent Python to parse HTML and call APIs** — "turning the harness into a coding agent." Takeaway: the `evaluate` tool we already have is a differentiator — expose it more, not less (with gating).

**Failure-mode research** (Invariant Labs, traces of hundreds of agent runs): looping from append-typing → overwrite default; hallucinated form data → "rely only on environment-extracted information"; a11y clicks doing nothing on dropdowns → direct `select_option`; stale refs after SPA re-render → snapshot-per-action + explicit stale errors; canvas/virtualized lists/cross-origin iframes → coordinate fallback; bot detection via TLS fingerprints → real (non-headless) WebView2 is actually a *good* fingerprint vs headless Chrome.

**MCP spec (2025-06-18 → 2025-11-25 → 2026-07-28 RC)**: **tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`) are the sanctioned auto-approval vocabulary; **elicitation** + **URL-mode elicitation** (SEP-1036) let the server hand sensitive steps (SSO/payment) to the user without secrets entering model context; **Tasks** for long-running ops; resource subscriptions for push instead of poll. Playwright and Anthropic both pass a human-readable element description on every action — a de-facto permission/audit string we should copy.

### 3b. User-facing agentic-browser UX

**Permission models converged on layered graduated autonomy:**
- **Claude in Chrome** (best-documented): global mode dial (Manual approve / Auto approve / Skip) → plan approval (agent lists sites it will touch) → per-site trust (allow once / always on this site / deny) with revocable history → **action-class hard gates** in every mode: downloads, sensitive info, purchases, deletions, permission changes. Auto mode **auto-downshifts** after repeated safety blocks.
- **OpenAI Operator/ChatGPT Agent**: watch mode (mandatory observation on sensitive tasks), confirmation gates before consequential actions, **privacy-shielded takeover** — for logins/payments/CAPTCHAs the agent hands over and "does not collect or screenshot information" while the user types. A separate monitor model pauses on suspicious page content.
- **Brave** (credible dissent on per-site prompts): per-site prompts are "repeated, low-signal security prompts" that train click-through (backed by habituation research: MISQ "Fog of Warnings"; polymorphic warnings slow habituation). Their substitute: **agent runs in an isolated profile** (no cookie crossing), all activity in a visible styled tab, prompts reserved for model-flagged high-risk moments, logs the agent cannot delete.
- **Edge Copilot Actions**: Light/Balanced/Strict site tiers, never-visit list, device permissions suspended while agent acts, screenshots retained 30 days.
- **Fellou**: plan-first — editable step plan approved before execution; steps run in a sandbox "Shadow Workspace"; pause-and-modify anytime.

**Progress visualization:** live one-line narration per step (ChatGPT Agent); screenshot strips as trust evidence (NN/g found these build trust); a cursor icon on the active tab so users can find the agent (Edge); post-hoc step review (Opera); plan-as-progress-artifact (Manus); `@tab` context chips (Dia).

**Interruption:** pause → progress summary on demand → stop with partial results; steer mid-task without restart (ChatGPT Agent). The archetypal failure is Genspark's: "no way to stop the bleeding except deleting it entirely."

**What users complain about (cross-product):** #1 slowness (NN/g measured Operator at 11 min on forms vs ~2 manual); permission fatigue ("asks permission for everything"); flaky regression waves (Comet Reddit threads); takeover windows that are low-res/unresizable (NN/g); no clarifying questions before expensive work.

**Checkpoint timing:** CDCR study (arXiv 2510.05307) — **81% prefer intermediate confirmations** over end-only, cutting completion time ~13.5%; confirm-every-step is tedious. Place gates at: domain-changing navigations, form submissions, anything irreversible.

**Security context:** Anthropic red-teamed Claude for Chrome — attack success 23.6% → 11.2% with mitigations; browser-specific challenges (hidden form fields, URL/title injection) 35.7% → **0%**. UW 2026: 4/7 agentic browsers vulnerable to SOP bypass via page-embedded injection. Brave's Comet writeup: hidden-text attacks that hijacked existing sessions. Our `evaluate` tool + shared cookie jar means **we currently have the "before" posture of these systems**.

### 3c. Infrastructure (WebView2 / embedding)

Confirmed reachable from our existing raw webview2-com path (Windows):

| Capability | API | Notes |
|---|---|---|
| CDP **events** (not just calls) | `ICoreWebView2_3::GetDevToolsProtocolEventReceiver` | Subscribe to `Network.responseReceived`, `Page.loadEventFired`, `Runtime.consoleAPICalled`… Must call `Network.enable` etc. first (we already call `Page.enable` at create, `browser.rs:1184`). Gotcha: keep the handler/token strongly referenced or you get silent failure/crashes (documented .NET GC bug; same discipline applies to COM handler lifetimes in Rust). |
| PDF export | `ICoreWebView2_16::PrintToPdf` / `PrintToPdfStream` | Stream variant avoids temp files. Works on hidden/off-screen webviews. |
| Downloads | `ICoreWebView2_4::DownloadStarting` | Intercept, set target path (workspace dir), track progress, cancel. Blocks default download UI, not the download. |
| Cookies | `ICoreWebView2CookieManager` | Read/create/delete cookies. |
| **Profile isolation** | `ICoreWebView2_19` + `ICoreWebView2ProfileManagement::CreateProfile` | **Multiple profiles under one user-data folder with separated cookies/storage** — the sanctioned isolation mechanism (one UDF = one environment instance, so separate UDFs per pane would NOT work; profiles do). Directly fixes our shared-cookie-jar problem. |
| Popups | `NewWindowRequested` | We deny on macOS; Windows path currently unhandled → default behavior. |
| Permissions | `PermissionRequested` | Geolocation/camera/etc. — should auto-deny for agent-driven browsing (Edge suspends device permissions while agent acts). |
| Process recovery | `ProcessFailed` | Renderer crash → reload affordance; currently unhandled. |
| Hidden-tab capture | `CapturePreview` **fails on truly hidden webviews** (not fully initialized when invisible; off-screen-positioned works) | Our primary path is CDP `Page.captureScreenshot` via `CallDevToolsProtocolMethod`, which doesn't depend on OS visibility — keep CDP as the canonical capture path; the off-screen parking we already do keeps `CapturePreview` viable as a true fallback. |

**Port handling:** the established pattern for local tool servers is **bind port 0 (ephemeral) → write a handshake file** (`<data_dir>/mcp/browser-mcp.json` with `{port, token, pid}`, restrictive ACL, stale-entry ignored on auth failure) **plus env-var passthrough** for children we spawn (we already pass `CONDUIT_WS_PORT`/`CONDUIT_MCP_AUTH_TOKEN`, so this is a small change). Fixed 7681 breaks multi-instance and loses to collisions silently (agents see `browser_unavailable` with no diagnosis).

---

## 4. Gap analysis mapped to our codebase

### P0 — Bugs / dead paths (fix this week)

1. **MCP `screenshot` tool unreachable**: the WS dispatch handles op `screenshot` (`browser_mcp.rs:313, 362–397`) but `tool_op` in the binary never maps it and `tools/list` never advertises it (`bin/conduit_browser_mcp.rs:218–226, 305–500`). Agents literally cannot take screenshots today.
2. **Circular screenshot fallback**: `capture_pane_png` → `capture_pane_png_via_cdp` → its "CapturePreview fallback" re-runs the same CDP call (`browser.rs:2096–2199`). Either land the real COM `CapturePreview` fallback or delete the branch. `browser_capture.rs` (32 lines, zero callers, stale doc) should be deleted.
3. **Tab titles/favicons never populate**: `setBrowserTabTitle` exists (`panes.ts:567`) but nothing calls it; `faviconUrl` never set; tabs always say "New Tab" (`BrowserPane.tsx:694`). The `browser:navigated` payload carries no title.
4. **Fixed port 7681**: second app instance or any collision silently degrades all agent browser tools (`browser.rs:245`, `lib.rs:203–220`). Move to ephemeral + handshake file (§3c).
5. **Back/forward buttons have no enabled/disabled state**: `browserHistory.ts` exports `canGoBack/canGoForward` but the component never uses them (`BrowserPane.tsx:567–589`); also open_pane_for_project hardcodes tab id `"default"` (`browser.rs:2493`).

### P1 — Agent capability gaps (highest leverage)

| # | Gap | Evidence / SOTA reference |
|---|---|---|
| 1 | **No snapshot returned with action results** — agent must call `read_page` separately after every click/type | Playwright returns fresh snapshot per action; chrome-devtools-mcp `includeSnapshot` flag; Anthropic attaches observation to batch results "to save a round trip" |
| 2 | **No stale-ref protocol** — `data-conduit-ref`s die silently on navigation; no explicit "stale, re-read" error; no no-renumber guarantee | Anthropic docs codify both behaviors; WebDriver stale-element problem reborn |
| 3 | **No `find` tool** — locating an element costs a full `read_page` | Anthropic `find` (NL description → ≤20 tagged matches); Playwright `browser_find` (text/regex over snapshot, "cheaper than capturing the whole snapshot") |
| 4 | **No direct form semantics** — `fill_form`/`select_option`/`press_key` missing; dropdowns fail via click-through (Invariant: top failure mode); typing appends rather than overwrites | Browser Use overwrite-default `input`; Anthropic `form_input` by ref |
| 5 | **No diagnostics** — console/network invisible to agents; debugging a misbehaving page = repeated screenshots | Playwright network/console core tools; chrome-devtools-mcp list+detail w/ filters; Anthropic incremental `read_console`/`read_network` |
| 6 | **`wait_for`/network-idle weak** — readyState + one 500ms recheck; no DOM-stable heuristic for streaming SPAs | chrome-devtools-mcp `waitForStableDom`; MutationObserver-based settle is cross-platform (JS-injected, no CDP needed on macOS) |
| 7 | **Snapshot token cost uncontrolled** — `read_page` has modes but no `depth`, no interactive-only filtering param at tool level, no table compaction, no truncation notice | Formatting choices alone worth 51–79% of snapshot tokens (dev.to A/B); label only interactive elements (789 → 245 refs on one page) |
| 8 | **No tabs tools for agents** — MCP resolves a single pane/tab; agent can't open/switch/close tabs or compare pages | Anthropic tab tools + compact `browser_state` block; Playwright `browser_tabs` |
| 9 | **No downloads or PDF** — agent can't hand a file to the workspace or export a page | `DownloadStarting` + `PrintToPdfStream` (§3c); Playwright `browser_pdf_save`; Browser Use `save_as_pdf`/`upload_file` |
| 10 | **No batch actions** — one roundtrip per micro-action | Anthropic batches with halt rule |
| 11 | **Tool schemas lack annotations** — no `readOnlyHint`/`destructiveHint` (clients can't auto-approve reads), no human-readable `element` description param for approval UX | MCP 2025-06-18 annotations; Playwright/Anthropic both carry the description param |
| 12 | **Screenshot only on Windows**; no `zoom` crop for small text | Anthropic `zoom` (region → upscaled crop); CDP `captureScreenshot` `clip` param makes zoom trivial cross-platform via CDP |

### P2 — User trust & experience gaps

1. **No permission model**: the agent can click/type/navigate anywhere in the pane with the user's real sessions and no gate, confirmation, or record. Every shipped competitor has at least action-class gates.
2. **No action timeline/audit trail**: `browser:activity` events already flow on every op — they're only used to surface the pane. Persist them into a per-session timeline (action, target description, URL, timestamp, result) that the user can inspect and the agent cannot delete (Brave's principle).
3. **No stop/pause control for browsing**: a stuck agent loop can only be stopped by killing the whole chat turn. Need a pane-level Stop that cancels the pending action and answers the MCP call with an error.
4. **No credential handoff**: when a page asks for login/payment, the agent either types secrets (which entered model context via the tool call) or fails. Need the Operator pattern: agent requests takeover → pane highlights → agent paused and blinded → user types → agent resumes.
5. **Shared cookie jar everywhere**: all panes/projects/agents share one WebView2 user-data folder; an agent prompt-injected on site X holds the user's session for site Y. `ICoreWebView2ProfileManagement` per project (or per agent-session) fixes the blast radius. Also: no logout/clear-session affordance anywhere.
6. **Silent failures**: `MAX_PANES` reached → `openBrowserPane`/`openArtifactInBrowserPane`/`restoreMinimizedBrowser` silently bail (`sessionLauncher.ts:198–259`).
7. **Watch-mode lacks narration labels** (cursor has no "typing email…" annotation) and the pane has no distinct agent-active visual treatment (Brave's "distinct action cues"; Edge's tab cursor icon).
8. **Prompt-injection exposure**: `evaluate` is arbitrary JS with the user's cookies; `read_page` uses Readability on rendered content (good — mostly visible text), but the interactive a11y mode can include hidden nodes; there's no URL un-trust signaling in the timeline. At minimum: mark untrusted page content in tool results, keep the nonce system, gate `evaluate`, deny `PermissionRequested` by default, handle `NewWindowRequested` on Windows (currently default), block `javascript:` in *all* navigation paths (only push-state paths check today).

### P3 — Hygiene

- Delete `browser_capture.rs`; fix the duplicated `#[cfg(windows)]` doc block (`browser.rs:629–632`); `history` op computes and discards watch opts (`browser_mcp.rs:695`).
- Linux panes drift between ResizeObserver syncs; ProcessFailed recovery absent; no renderer-crash affordance.
- Iframe fallback is second-class (8s timeout heuristic, no title events) — consider webview-on-Linux improvements before investing more in the iframe path.
- Occlusion inputs are manually wired and easy to regress (contextTip and tab-picker were both bugs) — centralize occlusion state.

---

## 5. Recommended roadmap

### Phase 0 — Fix what's broken (days)

1. Map + advertise `screenshot` in the relay binary (`tool_op` + `tool_schemas`); note it's Windows-only, return a clear error elsewhere.
2. Emit `title` (+ favicon URL) in `browser:navigated` (extract from NavigationStarting `WebResourceRequested` response headers or post-nav `document.title` eval) → wire `setBrowserTabTitle`/`setBrowserTabUrl`.
3. Ephemeral port + handshake file `<data_dir>/mcp/browser-mcp.json`; keep env passthrough; log "browser tools degraded: port bind failed" to the UI when applicable.
4. Delete `browser_capture.rs`, fix the circular fallback, wire back/forward button disabled states from the existing history stack.
5. Handle `NewWindowRequested` on Windows (deny or open-as-new-tab), auto-deny `PermissionRequested`, extend `javascript:` rejection to `create`/`navigate`.

### Phase 1 — Agent core upgrade (1–2 weeks) — *"make the agent fast and reliable"*

6. **Snapshot-with-action**: add `include_snapshot: bool` (default false for cheap ops, true after `click`/`type_text`/`select`) returning a compact interactive-only tree; add `depth`, `max_chars`, and a truncation notice. Build the compact serializer in `bridge_extract.js` (compress tables to one line, trim attributes, W3C accessible-name computation, interactive-only refs).
7. **Ref protocol**: make `data-conduit-ref`s stable-per-page-state, return the canonical stale-ref error, never renumber until navigation; keep CSS selector + scored-text targeting as secondary.
8. **New tools**: `find` (text/regex over snapshot refs; optionally scored NL description reusing `bridge_resolve.js` scoring), `fill_form` (multi-field by ref), `select_option` (by value/visible text), `press_key`, `batch` (ordered actions, halt-on-failure, observation on last result), `list_tabs`/`switch_tab`/`new_tab`/`close_tab` (tab = existing label scheme; return compact tab-state block).
9. **Diagnostics**: JS-injected ring buffer at document-start (patch `fetch`/`XHR`/`console`, keep last ~100 entries, bodies truncated) exposed via `read_console`/`read_network` (incremental "since last read"); on Windows upgrade to CDP `GetDevToolsProtocolEventReceiver` for response bodies (`Network.getResponseBody`). This is cross-platform day one because it needs only our existing eval bridge.
10. **Smarter waits**: MutationObserver DOM-stability heuristic (no mutations for ~500ms across 2 checks) behind `wait_for: "stable"`; keep text-based waits.
11. **Schema annotations**: `readOnlyHint` on read_page/find/history/screenshot/list_tabs; `destructiveHint` on evaluate/close; add the `element` human-readable description param on click/type/fill for the Phase-2 approval UX.
12. **`zoom`**: CDP `captureScreenshot` with `clip` + scale for small-text regions (Windows first; JS canvas fallback elsewhere).

### Phase 2 — Trust layer (2–3 weeks) — *"make users trust the agent"*

13. **Autonomy dial** (per project, persisted): Manual (confirm each consequential action) / Auto (default; gates only action-classes below) — mirroring Claude in Chrome; auto-downshift to Manual after N user-cancels.
14. **Action-class hard gates in all modes**: purchases/payments, credential fields, downloads, deletions/ submits of irreversible forms, permission grants. Gate implementation: `bridge_extract.js` already tags interactive elements — classify (form → password/input[type=tel email], button text scoring for buy/pay/delete/send/confirm) at action time; when gated, `run_action_for_pane` pauses (holds the MCP call), emits `browser:confirm-request` to the UI, user approves/denies → resolves. Add "always allow on this site" storing per-site consent (with the Brave caveat: keep prompts rare — gates are for action classes, not sites).
15. **Timeline/audit UI**: persist `browser:activity` (+ navigations + gate outcomes) into a per-session timeline panel; agent cannot delete it; export/clear is user-only. Show the human-readable `element` description from Phase 1 on each entry.
16. **Credential takeover**: when a gated credential field is detected, emit `browser:takeover-request`; UI focuses the pane, pauses + blinds the agent (drop pending actions, stop narration capture), shows "you're in control"; resume on blur/navigate or a Done button.
17. **Profile isolation**: one `ICoreWebView2ProfileManagement` profile per project (Windows first) so agent sessions don't share cookies across projects; add a "clear this site's session" affordance. macOS/Linux follow with their platform mechanisms (macOS: `WKWebsiteDataStore` non-persistent option).
18. **Stop/pause control**: pane-level Stop button → cancel pending action + answer MCP with `cancelled_by_user` error; Pause → hold next actions while keeping the WS session alive.
19. **Narration labels + agent-active styling**: text label following the synthetic cursor ("clicking 'Add to cart'", "typing email"), pane border tint + badge while watch-mode is active, cursor icon on the tab chip.
20. **Untrusted-content hygiene**: wrap page-derived strings in tool results with URL attribution; strip `display:none`/zero-opacity nodes from the interactive snapshot; keep hidden-text out of `get_page_text` (Readability already mostly does this).

### Phase 3 — Differentiators (later)

21. **DevTools-class surfaces for the coding-agent use case**: performance trace (`CDP Tracing`/`Performance.enable` → summarized insights), CPU/network emulation, viewport emulation — this is chrome-devtools-mcp's killer surface and Relay's users are coding agents previewing local apps.
22. **CLI/skill surface**: expose `conduit-browser` CLI verbs (open/read/click/fill/pdf…) for Claude Code-style harnesses — the 114K-vs-27K token lesson; keep MCP for interactive loops. A `browser-automation` skill can wrap the same WS.
23. **Structured extract**: `extract(prompt, json_schema)` reusing the chat LLM (server-side) over `get_page_text` output — Browser Use/Stagehand pattern; pagination via `start_from_char`.
24. **File upload**: allowlist-dir `upload_file` via `DataTransfer`/input-file JS injection; downloads routed to workspace via `DownloadStarting` with progress events into the timeline.
25. **WebMCP watch**: pages exposing tools to agents (W3C proposal, already in chrome-devtools-mcp) — natural fit for a general-purpose pane later.
26. **Cross-platform parity**: macOS CDP-equivalents via WKWebView script messages; Linux frameless-window tab capture for screenshots.

---

## 6. Token-cost & benchmark cheat sheet (for design arguments)

- A11y snapshot ≈ **200–400 tokens**; screenshot-to-VLM ≈ **3,000–5,000** (playwright.dev/mcp/snapshots).
- Snapshot formatting choices worth **51–79%** of tokens (14.5K → 3.1K on HN front page); interactive-only labeling cut refs 789 → 245.
- Coding-agent flow: MCP ≈ **114K tokens/test vs 27K via CLI/skill** (third-party measurement, 2026).
- WebArena: GPT-4 14.41%, human 78.24%, CUA 58.1%. Online-Mind2Web (cleaner): Operator 61%, Atlas agent 71%, Browser Use bu-max 97% (own harness). WebVoyager vendor ~90% claims → **30–61%** under clean eval ("Illusion of Progress").
- Anthropic Claude-for-Chrome red team: 23.6% → 11.2% ASR with mitigations; hidden-text/URL-title challenges 35.7% → 0%.
- NN/g: Operator 11 min on a form vs ~2 manual; screenshot evidence builds trust; takeover UX matters (low-res takeover window = complaint).
- CDCR (arXiv 2510.05307): 81% prefer intermediate confirmations; ~13.5% faster than end-only.
- UW (Jun 2026): 4/7 agentic browsers → SOP bypass via prompt injection.

---

## Appendix — Key sources

**Tool design**: [Playwright MCP](https://github.com/microsoft/playwright-mcp) · [snapshots](https://playwright.dev/mcp/snapshots) · [chrome-devtools-mcp tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md) · [Chrome blog](https://developer.chrome.com/blog/chrome-devtools-mcp) · [Browser Use](https://github.com/browser-use/browser-use) · [speed matters](https://browser-use.com/posts/speed-matters) · [Online-Mind2Web post](https://browser-use.com/posts/online-mind2web-benchmark) · [Anthropic browser toolset](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool) · [computer use toolset](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) · [Claude for Chrome](https://www.anthropic.com/news/claude-for-chrome) · [Stagehand](https://github.com/browserbase/stagehand) · [Skyvern 2.0](https://www.skyvern.com/blog/skyvern-2-0-state-of-the-art-web-navigation-with-85-8-on-webvoyager-eval/)
**Research**: [Illusion of Progress](https://arxiv.org/html/2504.01382v4) · [AgentOccam](https://arxiv.org/html/2410.13825) · [SoM](https://arxiv.org/abs/2310.11441) · [SeeAct](https://arxiv.org/abs/2401.01614) · [CDCR confirmations](https://arxiv.org/abs/2510.05307) · [Invariant failure analysis](https://invariantlabs.ai/blog/what-we-learned-from-analyzing-web-agents) · [snapshot token formatting study](https://dev.to/kuroko1t/how-accessibility-tree-formatting-affects-token-cost-in-browser-mcps-n2a) · [MCP vs CLI tokens](https://scrolltest.medium.com/playwright-mcp-burns-114k-tokens-per-test-the-new-cli-uses-27k-heres-when-to-use-each-65dabeaac7a0) · [MCP annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) · [MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/changelog) · [MCP 2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) · [Gemini computer use](https://blog.google/innovation-and-ai/models-and-research/google-deepmind/gemini-computer-use-model/)
**UX & safety**: [Operator](https://openai.com/index/introducing-operator/) · [ChatGPT agent](https://openai.com/index/introducing-chatgpt-agent/) · [Atlas](https://openai.com/index/introducing-chatgpt-atlas/) · [Claude in Chrome permissions](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide) · [Cowork safety](https://support.claude.com/en/articles/13364135-use-claude-cowork-safely) · [Edge Copilot Mode](https://blogs.windows.com/msedgedev/2025/07/28/introducing-copilot-mode-in-edge-a-new-way-to-browse-the-web/) · [Browse with Copilot](https://support.microsoft.com/en-us/microsoft-copilot/browse-with-copilot) · [Brave AI browsing](https://brave.com/blog/ai-browsing/) · [Brave Comet injection](https://brave.com/blog/comet-prompt-injection/) · [Opera Operator](https://press.opera.com/2025/03/03/opera-browser-operator-ai-agentics/) · [Manus Plan Mode](https://manus.im/blog/manus-plan-mode) · [NN/g ChatGPT agent](https://www.nngroup.com/articles/impressions-chatgpt-agent/) · [UW agentic browser study](https://www.washington.edu/news/2026/06/30/some-agentic-ai-browsers-come-with-major-cybersecurity-risks-uw-study-finds/) · [Fog of Warnings](https://misq.umn.edu/misq/article/49/4/1357/3281/The-Fog-of-Warnings-How-Non-Security-Related)
**WebView2**: [CDP in WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/chromium-devtools-protocol) · [GetDevToolsProtocolEventReceiver](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.getdevtoolsprotocoleventreceiver?view=webview2-dotnet-1.0.4129.50) · [event receiver GC gotcha](https://blog.elijahlopez.ca/posts/dotnet-webview2-garbage-collection-bug/) · [ICoreWebView2_16 (Print/PrintToPdf)](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_16?view=webview2-1.0.4129.50) · [DownloadStarting](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.downloadstarting?view=webview2-dotnet-1.0.4129.50) · [CookieManager](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2cookiemanager?view=webview2-dotnet-1.0.4129.50) · [Multi-profile spec](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/MultiProfile.md) · [user data folder](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder) · [hidden-webview capture limits](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3266) · [CapturePreview viewport-only](https://github.com/MicrosoftEdge/WebView2Feedback/issues/733)
