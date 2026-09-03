# Relay Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Naming note:** "Relay" is the user-visible product name (window title, `package.json` name, `tauri.conf.json` `productName`, `<title>`, sidebar/banner/HTML strings). The Rust crate name, the bundle identifier (`dev.conduit.app`), the NSIS installer filename pattern, the mobile app name (`Conduit Mobile`), the mobile bundle identifier (`com.conduit.mobile`), and the Windows scheduled-task name (`ConduitAutomations`) are still "Conduit" / `conduit` — the rebrand (`e9abc7c3`) was deliberately limited to user-visible surfaces. See `AI CONTEXT/RELEASE.md`.

---

## [Unreleased]

### Added
- **Three new harnesses: Pi, Omp, CommandCode** — the harness registry grows from three CLIs to six, each with a full adapter (spawn / resume-by-id / login / session-id capture / usage scraping / diff-approval prompts, all conservative per the adapter contract). Flags verified against upstream sources: Pi (`@earendil-works/pi-coding-agent`) resumes via `pi --session <id>`, auth is the in-TUI `/login`; Omp (`@oh-my-pi/pi-coding-agent`) resumes via `omp --resume <id>`, login is `omp setup`; CommandCode (`command-code`) resumes via `--resume <id>`, login is `commandcode login`. Adapter presentation order is now deterministic (`ADAPTER_ORDER`) so Settings/agent-picker rows stop reshuffling as the registry grows. New harnesses work in interactive panes (spawn/resume/login), the sidebar harness select, the agent picker rail (monogram glyphs), and the one-click npm install; the headless chat/automations turn backend is unchanged (a chat turn on the new ids reports "no headless chat backend yet", same as kimi in automations).
- **One-time Install from the automations failure banner** — when an automation's last run failed and its harness CLI isn't installed on this device, the banner's "Run again" button becomes "Install" (npm install -g, with progress + error toasts); once the install lands and the re-probe sees the binary, the button flips back to "Run again". The plain-language spawn-failure hint now points at the Install affordance; the banner hint names the missing CLI.
- **`automationHarnessInstall.test.ts`** — covers the harness-missing decision (registered-but-not-installed → Install; provider/local agents never match) and the hint copy.
- **`get_capabilities` — in-process availability introspection** — a dedicated read-only tool that answers "which connectors / MCP servers / skills are available?" from the turn's live `ToolCaps` (attached connectors with their tool lists, attachable connectors, attached MCP-gallery servers grouped by wire name, attachable servers, enabled built-ins) instead of a config file. Agents no longer have a reason — or permission — to spawn a Terminal just to inspect connector/MCP availability. Three surfaces:
  - **Built-in chat + subagents** — advertised in both provider schemas (always on, no approval); the report embeds the terminal lifecycle contract so the model reads live limits, not stale prompt text.
  - **Harness CLIs (Claude Code / Kimi / OpenCode)** — the `conduit-tools` MCP server gains `get_capabilities` (`tool_op` mapping, `tools/list` schema, relay whitelist); it reports the app-level state (connected connectors, installed/enabled MCP-gallery servers, in-app browser surface, skills). The harness environment preamble tells CLIs to use it instead of running `claude mcp list` in their TUI.
  - **Anti-probe guard** — the `run_shell` dispatch refuses `mcp list`-style availability probes (MCP mention + probe verb — `list`/`ls`/`status`/`which`/`where`/`--version` — high-precision, so `claude mcp add`, `grep mcp src/`, `git status` all pass) with a redirect message pointing at `get_capabilities`. The attach-manifest prompt segment and the `run_shell` description state the same contract.
- **Terminal process lifecycle rules** — every model-started shell now belongs to exactly one of four classes, defined once in `chat::tasks` (module doc + constants) and enforced in code, with the `run_shell` tool description teaching them:
  - **Foreground** (default): runs to completion, output returned inline, hard 120s ceiling (`SHELL_FOREGROUND_TIMEOUT_SECS`); an explicit `timeout_secs` may only shorten the run.
  - **Temporary**: explicit `timeout_secs` (5–3600, auto-clamped) — the engine kills the process exactly at the deadline (foreground **or** background) and reports the timeout; no cleanup needed.
  - **Background**: `run_shell(background: true)` returns a task id immediately; output streams via `get_task_status`; killed by `cancel_task` or app exit (`kill_on_drop`).
  - **Long-running**: background without `timeout_secs` (dev servers, watchers, long installs) — no engine deadline, but the model owns the `cancel_task` cleanup.
  - `run_shell_to_completion` takes its timeout as a parameter; the background `shell_task` enforces the Temporary deadline in its select loop. The old timeout notice that pointed at the nonexistent `start_shell` tool now points at `background: true`.
- **Research P1/P2 backlog** — the remaining improvements from `RESEARCH_MODE_IMPROVEMENTS_RESEARCH.md`:
  - **Citation-chip verification colors** — chips cited by the end-of-turn lint render amber (weak attribution) or red (orphan source); verdicts reach the bubbles via `chat:citation-report` payload numbers and a React context, so the memoized markdown cache needs no re-keying.
  - **Async citation-precision sampler** — when the heuristic lint flags weak attributions, a single background model call re-judges up to 12 flagged claim/excerpt pairs with the session's own provider; "supported" verdicts clear flags live (a refined report re-emits + persists), "unsupported" confirms them. Skipped for local models (no extra context spend).
  - **"Fix citations" repair action** — flagged reports show a button on the citation strip that pulls the stored lint detail and sends a RARR-style repair instruction: re-cite from the ledger, re-read the flagged source, or drop the claim; regenerate the artifact.
  - **Compact ledger mode** — `get_source_ledger(mode:"compact")` returns the claim index without verbatim excerpts for small-context/local models with large ledgers.
  - **Deep-tier fan-out guidance** — broad multi-area research may spawn 2–4 `task` subagents (one per sub-question cluster) recording into the shared ledger and returning compressed findings; the lead dedupes, resolves conflicts, and still passes the sufficiency gate.
  - **Citation-quality trend** — `citation_quality_trend` aggregates lint counts over recent reports: flag-ratio drift after a prompt/model change is the regression signal.
  - **Anchor-based weak attribution** — the heuristic now measures containment over a claim's load-bearing tokens (numbers, dates, proper nouns) instead of all content words; real-run over-flagging (44/63 "weak" on a clean report) drops to a sane rate while unrelated-claim misattribution still trips it.

### Fixed
- **Full-auto by default everywhere** — new built-in and local-GGUF chat sessions are created `workspace_write` + `full_access` (no per-action approval cards), matching the harness CLIs, which all run headless turns unrestricted (`--dangerously-skip-permissions` for claude, kimi prompt auto-approve, opencode `--auto`, pi `--approve`, omp `--auto-approve`, commandcode `--yolo --tools-all`). The pi-lineage turn flags are now explicit rather than relying on print-mode defaults. read_only / plan / auto_edit stay one switch away in the mode menu, and legacy rows still fail closed to manual. Ejecting a harness back to built-in now applies the real full-auto policies (silently — no confirmation modal — since full-auto is the default) instead of a label-only reset that left older sessions on per-action approvals.

- **Agent picker no longer freezes while harness models load** — `list_harness_models` was a sync Tauri command (main thread), and the new pi/omp/commandcode discovery live-probes each CLI (1–3s node/bun cold start per probe), so opening the agent picker froze the whole window for seconds. It is now async with the probe work on a blocking thread pool plus a 30s TTL cache, matching `list_harnesses`/`list_acp_agents` ("opening the agent menu must never freeze the window").
- **Harness turn permission model verified + first-send flash removed** — pi/omp print modes auto-approve tool calls (verified live: a file-creating headless turn executed with no approval flag; pi's `--approve` is project-trust for local extensions/settings and is deliberately left at the safe "ignore" default), CommandCode runs with `--yolo`; documented at the spawn site. The per-send "… is starting up…" chat status is now Kimi-only — for pi/omp/commandcode it was noise, since the CLI is already exercised at agent/model selection time.
- **Headless resume verified on-device** — pi (`--session <id>`) and omp (`--resume <id>`) both continued prior sessions by the captured CLI session id and recalled context (codeword round-trips); the pi session store lives at `~/.pi/agent/sessions/<cwd-slug>/` keyed per project.

- **Headless chat + automations for Pi, Omp, and CommandCode ("true streaming")** — the per-turn engine now speaks all three CLIs' JSON event protocols, verified live on-device: pi/omp stream `-p --mode json` (`message_update`/`text_delta` deltas, thinking blocks, tool execution markers, cumulative usage, session header for cross-turn resume); CommandCode streams `-p --output-format json` (`{"type":"event"}` frames + final `result` line, liberal delta matching with a `finalText` catch-up so the reply lands even if event names drift). Model discovery reads each CLI's live listing (`pi --list-models` table, `omp models --json`, `commandcode --list-models` with the `(default)` marker) plus pi's `~/.pi/agent/{settings,models}.json` (default model, custom-provider endpoint); Pi and Omp (and CommandCode) now also appear in the automations/agent pickers with their official logos (pi.dev pixel-π, omp.sh glyph, commandcode.ai cmd symbol).
- **Fixed the Windows prompt transport for npm-shim harnesses** — the M12 env+wrapper design silently breaks for CLIs installed as npm `.cmd` shims: a batch-to-batch hand-off passes the RAW line to the shim, whose `endLocal … %*` tail re-expands it with delayed expansion OFF, so the `!CONDUIT_TURN_PROMPT!` placeholder reached the CLI as literal text (reproduced with an argv-dump shim; kimi/opencode were unaffected only because they ship native .exe binaries). pi/omp/commandcode turns now pipe the prompt to the child's stdin (verified live: exact prompts answered through the real cmd.exe wrapper), with the E-7 kill-the-tree contract on write failure.
- **Install flow is now self-verifying** — after `npm install -g` succeeds, `install_harness` polls the CLI's `--version` for up to ~15s (freshly written shims can fail their first probe while Defender scans), so the harness row flips to "installed" without a manual Re-check; if the CLI still doesn't run, the toast says so. omp additionally reports up front that its npm distribution requires Bun (the earlier "installed but still shows Install" symptom on this device was exactly this — Bun was missing; installing it made `omp --version` pass).

- **Settings "Re-check" now actually re-checks** — `list_harnesses` serves a 30s in-memory cache, and the button used to call that same cached command, so a harness installed or uninstalled out-of-band (manual `npm install -g`, PATH change) showed no change for up to 30s no matter how often you clicked. The command takes a `force` flag that bypasses (and refreshes) the cache; the Re-check button passes it, shows a "Checking…" state while the probe runs, and toasts instead of failing silently when the backend call errors. The in-app install flows (Settings + automations banner) also force the follow-up probe; boot and the agent picker keep the cheap cached path.
- **Citation hover preview no longer overlaps text** — the source preview card renders through a portal at `document.body` with fixed positioning (flip below when out of room, viewport-clamped, opaque background, top z-layer): it used to be absolutely positioned inside the markdown flow, where virtualizer rows and markdown blocks' own stacking contexts painted over it and scroll containers clipped it.
- **Native link-title tooltips removed from chat markdown** — OS-positioned `title` tooltips painted over surrounding text unrecoverably; plain links open in the browser pane on click, citations have their rendered preview cards.
- **Citation check strip restyled** — proper CSS classes (glass tokens, single compact row, truncating hint, health dot green/amber/red, "Fix citations" pill); the inline-styled version wrapped into a tall multi-line block.

### Added
- **Research mode overhaul (P0 foundation + trust layer)** — The research system (`RESEARCH_MODE_IMPROVEMENTS_RESEARCH.md`) upgrade, end to end:
  - **Multi-engine keyless search** — `web_search` now merges DuckDuckGo HTML, Mojeek (independent index), and Wikipedia with per-engine health reporting (`engine health: … FAILED` degrades honestly instead of "no results"). The dead DuckDuckGo Instant Answer API (returns empty payloads since long ago) was removed — it masked real outages as empty result sets.
  - **BYO-key search engines** — Settings → Web Search: Serper (Google), Tavily, or Brave replace the keyless SERP engines when configured (keys stored via the generic settings store; Wikipedia stays as a supplement). Brave-only payloads are never cached, per Brave's storage terms.
  - **Readability extraction + Jina Reader fallback** — `fetch_url` extracts articles with `dom_smoothie` (Readability.js port; byline/publish-date surfaced), falls back to the tag-stripper for non-article pages, and falls back to the keyless `r.jina.ai` reader when a fetch is blocked or the target is a PDF (PDFs are now readable). Text budget per read raised 12 KB → 32 KB. SSRF guards run before both paths.
  - **Research caches** — SQLite `search_cache` (12 h TTL) and `page_cache` (7 day TTL, canonical-URL keyed, tracking params stripped) so re-reading a source never re-hits the wire; `research_queries` history powers a repeat-query nudge ("each research query should explore NEW ground") and a per-session search audit trail; `reset_source_ledger` clears both.
  - **Citation-integrity lint** — End of every research turn, the generated report is mechanically checked against the source ledger (zero model calls): orphan citations (`[n]` pointing at sources never read), unused ledger sources, uncited sentences, and weak attribution (cited sentence shares too little vocabulary with the stored verbatim excerpt — the "quote absent from the cited article" failure class). Verdict persists in `citation_reports` and rides to the UI as `chat:citation-report`, rendered as a trust strip above the composer (green/amber/red).
  - **Evidence-sufficiency gate** — New `check_sufficiency` tool: before synthesizing, the model must declare per-sub-question status (≥2 independent sources, opposing views looked for); the tool returns SUFFICIENT / NOT SUFFICIENT with the gaps spelled out.
  - **Source metadata** — `add_source_note` gains optional `publisher` / `publishedAt` (from page metadata); the ledger schema carries both, and the research prompt now requires explicit conflict handling: prefer fresher/more authoritative sources, state both positions with dates when genuinely ambiguous, never average into a false consensus.
  - **Scope phase** — Research scaffolding now opens with a brief + optional (max 2) clarifying questions for ambiguous asks before any search spend.
- **Cloud context compaction (P1)** — Cloud/API sessions now compact like local ones: pre-send estimate against a per-model window triggers the same pin+summarize engine, with the session's OWN provider writing the summary; persisted `[compacted context]` rows supersede folded turns. A provider context-overflow rejection is now classified (`context_overflow`), auto-compacted, and retried once instead of dying as a raw 400 banner.
- **Per-model context-window registry (P0)** — The flat 500k ceiling is retired for the meter: a per-model registry (mirrored backend/frontend) resolves real windows (Claude 200k, GPT-5 400k, GPT-4.1 1M, Gemini 1M, …) with the 500k figure as fallback; OpenRouter's live `context_length` is no longer capped. Cloud/harness meters poll a live backend estimate (system + history + tool schema) and take the max with the provider-counted last turn, so warn/crit can actually fire before an overflow. The hover breakdown is estimated per category from real content (no more fabricated 15/70/10/5 split).
- **Overflow error classification (P0)** — `chat:error` carries a machine-readable `code`; provider phrasings across Anthropic/OpenAI/OpenRouter/llama-server/Google map to `context_overflow`, with actionable banner copy instead of a raw provider blob.
- **"Compact now" (P1)** — Manual forced compaction for the active session from the context-meter panel (`chat_compact_now`), cloud and local.
- **Context recovery UI (P2)** — The `[compacted context]` marker gains a "show folded turns" disclosure: the raw turns a summary folded away are fetched from the DB on demand (the summary is lossy; the rows are the restorable source) via `list_compacted_messages`.
- **Structured summary schema (P2)** — The shared summarization prompt now produces the 9-section schema (primary request/intent, decisions, files & code, errors & fixes, all user messages, pending tasks, current work, next step, pointers), tuned recall-first — errors are kept as evidence, never discarded. Per-message head+tail trimming protects the summarizer budget from single oversized turns.
- **Map-reduce summarization (P4)** — Local compaction no longer silently drops the aged-out turns that don't fit the summarizer budget: they're chunked, map-summarized, and folded into the main call; summary output cap raised 1024 → 2048.
- **Summarizer override + rebuild-from-raw (P4)** — `chat.local_gguf.compaction_summarizer = "cloud"` routes local summaries through a configured cloud provider; rebuild-from-raw re-derives each new summary from the ORIGINAL folded turns instead of stacking summary-on-summary.
- **Harness context observability (P3)** — Claude Code's own auto-compact (`compact_boundary`) persists a boundary marker and refreshes the meter; `/compact` and `/microcompact` are offered in the composer for harness sessions (forwarded verbatim to the CLI).
- **Harness primer upgrade + resume-gap fix (P3)** — The engine-switch context primer now carries a cloud-summarized digest of the turns that exceed its (raised) 32k-char tail budget; a stale `--resume` id that kills the CLI before any turn activity is detected, dropped, and the next send replays the primer instead of resuming blank.

### Changed
- Compaction settings consolidated: one "Compaction (advanced)" panel covers local (threshold, pin, summarizer, rebuild-from-raw) and cloud (enabled, threshold, pin) engines; cloud overflow-retry runs regardless of the master switch.

---

## [0.4.2] — 2026-08-31

### Added
- **Boot splash + onboarding modal** — Brand logo shown during app startup; first-run local-model onboarding modal ([7321d69](https://github.com/Conduit-official/Conduit/commit/7321d69))
- **Parallel subagents with tools** — Subagents can now use tools in parallel; agent chips appear everywhere ([8476da2](https://github.com/Conduit-official/Conduit/commit/8476da2))
- **CDP execution layer** — Phase 1 of the Chrome DevTools Protocol layer for the in-app browser; subagent rounds raised to 100 ([6f5e452](https://github.com/Conduit-official/Conduit/commit/6f5e452))
- **Queued messages notch stack** — Steer, edit, delete, and drag-reorder pending messages before they're sent ([1c5bae6](https://github.com/Conduit-official/Conduit/commit/1c5bae6))
- **Subagent pane at chat-view fidelity** — Ordered segments, streamed thinking, and DiffCards in the agent pane ([d541f3d](https://github.com/Conduit-official/Conduit/commit/d541f3d))
- **Structured plan tracking** — Model-declared plans surface in chat with a Plan posture; harness-native modes ([19e63f2](https://github.com/Conduit-official/Conduit/commit/19e63f2))
- **Split chat view** — Full-fidelity second ChatView with glass session menu and a draggable split divider; tool panel docks beside the focused half ([e63de9c](https://github.com/Conduit-official/Conduit/commit/e63de9c), [5aed56c](https://github.com/Conduit-official/Conduit/commit/5aed56c), [c0e7b21](https://github.com/Conduit-official/Conduit/commit/c0e7b21))
- **Git file viewer with inline diffs** — Per-type file icons, click-to-expand inline diffs, Unstaged/Staged/All-branch/Last-turn filters, styled review cards with full markdown prose ([f4f9b21](https://github.com/Conduit-official/Conduit/commit/f4f9b21), [332ce72](https://github.com/Conduit-official/Conduit/commit/332ce72), [bcd7de1](https://github.com/Conduit-official/Conduit/commit/bcd7de1))
- **GitHub pull requests — liquid glass scope dropdown** — Scope selector uses liquid glass; GitHub API routes through git's proxy config ([bc605d0](https://github.com/Conduit-official/Conduit/commit/bc605d0))
- **Welcome screen refresh** — Time-aware greeting, icon cards, 500k context ceiling for cloud/harness meter ([2e85de8](https://github.com/Conduit-official/Conduit/commit/2e85de8))
- **Relay branding in agent prompts** — Agent self-identifies as Relay across cloud, local, and harness system prompts ([0b6e4e3](https://github.com/Conduit-official/Conduit/commit/0b6e4e3))
- **Full-fidelity document pipeline** — Browser-grade PDF via WebView2 + Paged.js, docx npm + PptxGenJS generation, pdf.js + docx-preview viewers; built-in `/docx`, `/pptx`, `/pdf` skills rewritten ([3c7b60e](https://github.com/Conduit-official/Conduit/commit/3c7b60e))
- **Fold same-tool rows** — Compact edit rows, sidebar more-popovers; 1M context default ([449183d](https://github.com/Conduit-official/Conduit/commit/449183d))

### Fixed
- **Audit sweep** — Relay auth fail-open, browser pane results, stream watchdogs, lifecycle wedges, data integrity ([7a5d6f3](https://github.com/Conduit-official/Conduit/commit/7a5d6f3))
- **Agent browser calls** — Reuse the existing Browser chip instead of stacking a duplicate; settings/skills/cost keep the chat mounted ([2495c8a](https://github.com/Conduit-official/Conduit/commit/2495c8a), [960bf75](https://github.com/Conduit-official/Conduit/commit/960bf75))
- **WebView2 controller ownership** — Own WebView2 controller via webview2-com; touch marshals through main thread; controllers created invisible then shown ([18f33f0](https://github.com/Conduit-official/Conduit/commit/18f33f0), [cfa8eb8](https://github.com/Conduit-official/Conduit/commit/cfa8eb8), [d4ccfdb](https://github.com/Conduit-official/Conduit/commit/d4ccfdb), [9d3158e](https://github.com/Conduit-official/Conduit/commit/9d3158e))
- **Browser pane wedge** — Fixed nested message pump; per-model context windows; real harness model in meter/cost ([8ee0742](https://github.com/Conduit-official/Conduit/commit/8ee0742))
- **Harness subagent visibility** — Recognize Claude Code's Agent tool (renamed from Task); permission modes actually apply; harness questions get answerable cards ([08aade6](https://github.com/Conduit-official/Conduit/commit/08aade6), [8178ea6](https://github.com/Conduit-official/Conduit/commit/8178ea6))
- **Agent cursor/typing visuals** — Now appear on every browser page ([d509d11](https://github.com/Conduit-official/Conduit/commit/d509d11))
- **Inline subagent chips** — Render correctly during parallel fan-out; click opens one agent pane ([91da3e2](https://github.com/Conduit-official/Conduit/commit/91da3e2))
- **Queue notch polish** — One container, compact inline edit, pointer-based reorder ([2d81808](https://github.com/Conduit-official/Conduit/commit/2d81808))
- **Subagent research stack** — Subagents get the full read-side research stack; proxy-proof fetch guards ([d342804](https://github.com/Conduit-official/Conduit/commit/d342804))
- **Stale turn timer** — Background-chat spinners, harness mode reset, camelCase tool args ([e109475](https://github.com/Conduit-official/Conduit/commit/e109475))
- **Web app preview** — Models can now open/preview built web apps in the in-app browser ([75dc0a6](https://github.com/Conduit-official/Conduit/commit/75dc0a6))
- **TypeScript fallbacks** — Chat-store fallbacks clear 48 `TS18046 unknown` errors ([c6f4e11](https://github.com/Conduit-official/Conduit/commit/c6f4e11))
- **Metrics HUD accuracy** — Provider-aware cache rate, decode tok/s, request-anchored TTFT, marker-free token counts, live IN/CACHE display ([9df118b](https://github.com/Conduit-official/Conduit/commit/9df118b))
- **Artifact gallery cards** — Uniform heights; agent-gated pane auto-open ([76d023b](https://github.com/Conduit-official/Conduit/commit/76d023b))
- **Split/tool panel** — Global tool panel (no docking); git rail only in the focused half; ✕-only split close ([95a3a74](https://github.com/Conduit-official/Conduit/commit/95a3a74))
- **Folded/edit row buttons** — Kill global button skin; rim shadow + hover background ([52e50cf](https://github.com/Conduit-official/Conduit/commit/52e50cf))
- **Git file spinners** — Spinner on scope switch; Send PR/Review-all scoped to focused chat with real feedback ([487ec66](https://github.com/Conduit-official/Conduit/commit/487ec66), [eb483ff](https://github.com/Conduit-official/Conduit/commit/eb483ff))
- **Docx preview overflow** — Scale pages to fit pane width (fit-to-width) ([0e951c4](https://github.com/Conduit-official/Conduit/commit/0e951c4))

### Changed
- **Welcome screen** — Time-aware greeting with icon cards; 500k context ceiling for cloud/harness meter ([2e85de8](https://github.com/Conduit-official/Conduit/commit/2e85de8))
- **GitHub pull requests** — GitHub API routes through git's proxy config ([bc605d0](https://github.com/Conduit-official/Conduit/commit/bc605d0))
- **Chat message text** — Dimmed with new `--chat-text` token, scoped to bubbles ([fad62ea](https://github.com/Conduit-official/Conduit/commit/fad62ea))
- **Git file view** — Compact diff gutters, liquid-glass filter menu, loading spinners ([eb483ff](https://github.com/Conduit-official/Conduit/commit/eb483ff))
- **Session menu** — Uses the composer's liquid glass (true-transparent body, blur24/sat160, 16px) ([b4ea2cc](https://github.com/Conduit-official/Conduit/commit/b4ea2cc))
- **Browser pane** — Edge-to-edge layout, no glass-card inset; page owns the panel like docs/html ([e255dd3](https://github.com/Conduit-official/Conduit/commit/e255dd3))
- **UI animations** — Smooth expand/collapse animations matching the tool-panel slide ([3c1aa27](https://github.com/Conduit-official/Conduit/commit/3c1aa27))

---

## [0.4.1] — 2026-08-17
- **Full-fidelity document pipeline (doc/ppt/pdf)** — New generation + preview engines across every document format:
  - **PDF generation via a real browser engine** — `generate_document` for pdf now takes `language: "html"` (default): the model authors styled HTML, which renders in a hidden WebView2 window with the Paged.js polyfill (real `@page` margin boxes, page numbers, running headers) and prints with `ICoreWebView2_7::PrintToPdf` — full CSS/SVG/Unicode/CJK support, replacing the hand-rolled Latin-1-only PDF writer
  - **DOCX generation via the `docx` npm library** (default `language: "javascript"`) — the model's program runs in a sandboxed iframe (`DocCodeRunner`) with the library preloaded, delivering real editable OOXML (headings, tables, numbering, styles) with no Python dependency; Python/`conduit_docgen` remains as fallback
  - **PPTX generation via PptxGenJS** (default `language: "javascript"`) — 16:9 layouts, native charts, slide masters, with the documented gotchas (hex colors, explicit layout) encoded in the prompts/skills
  - **PDF.js viewer** — in-app PDF pane rebuilt on pdf.js (page nav, zoom, text search, text selection), identical on WebView2/WKWebView/WebKitGTK, replacing the native `<embed>` whose behavior varied with the Evergreen runtime (and doesn't exist on Linux)
  - **docx-preview viewer** — DOCX previews render with real document styles, headers/footers, numbering and images via docx-preview, falling back to the backend HTML converter on parse failure; new "PDF view" toggle converts the original file through LibreOffice for true pagination (`office_accurate_pdf`)
  - Built-in `/docx`, `/pptx`, `/pdf` skills rewritten for the new engines
- **Relay rebrand** — User-visible product name switched from "Conduit" to "Relay" (window title, `package.json` name, `tauri.conf.json` `productName`, `<title>`, sidebar/banner/HTML strings, frost fix for toolbar popovers) ([e9abc7c3](https://github.com/Conduit-official/Conduit/commit/e9abc7c3))
- **Recognizable app icons + branded installer** — New app icon set, branded installer artwork, standalone YouTube consent card ([03c2ab8a](https://github.com/Conduit-official/Conduit/commit/03c2ab8a))
- **Git Graph commit table** — Drop the branch list, roomier rows, clip descriptions ([d834ad70](https://github.com/Conduit-official/Conduit/commit/d834ad70), [3791b529](https://github.com/Conduit-official/Conduit/commit/3791b529))
- **Floating composer over transcript** — Composer floats over the transcript; messages scroll behind the glass, edge reservations, transparent app logo ([bd69c970](https://github.com/Conduit-official/Conduit/commit/bd69c970), [f772979b](https://github.com/Conduit-official/Conduit/commit/f772979b), [2816f9da](https://github.com/Conduit-official/Conduit/commit/2816f9da), [a6088241](https://github.com/Conduit-official/Conduit/commit/a6088241))
- **Liquid glass across the app** — Composer glass extended to sidebar, modals, QR frame ([86588979](https://github.com/Conduit-official/Conduit/commit/86588979), [09449738](https://github.com/Conduit-official/Conduit/commit/09449738), [3ef47dca](https://github.com/Conduit-official/Conduit/commit/3ef47dca), [20b3c207](https://github.com/Conduit-official/Conduit/commit/20b3c207))
- **Git sidebar enhancements** — Collapsible sections, liquid glass, chat-bound data ([11837617](https://github.com/Conduit-official/Conduit/commit/11837617))
- **Right tool panel as a slide-out** — Tool panel slides open/closed like the sidebar ([a6a2ccdb](https://github.com/Conduit-official/Conduit/commit/a6a2ccdb))
- **Mode-colored permission chip** — Permission chip tinted by current mode ([f2c5af11](https://github.com/Conduit-official/Conduit/commit/f2c5af11))
- **YouTube connector** — Standalone YouTube card in the connectors panel ([f2c5af11](https://github.com/Conduit-official/Conduit/commit/f2c5af11))
- **Toolbar as title bar** — Slimmer title bar; Conduit + nav arrows live only in the sidebar ([85bcd924](https://github.com/Conduit-official/Conduit/commit/85bcd924))
- **GitHub-notch popover** — Glass on the wrapper, left-anchored under the chip ([573582b4](https://github.com/Conduit-official/Conduit/commit/573582b4))
- **Mermaid stateLabelColor fix** — state/flow node labels visible ([55740144](https://github.com/Conduit-official/Conduit/commit/55740144))
- **Composer chip with provider icon** — Chip shows the provider icon, not the provider name ([1ac84047](https://github.com/Conduit-official/Conduit/commit/1ac84047))
- **Agent/Model picker redesign** — Combined agent/model selection with icon rail and per-model local runtime settings ([cb7d782a](https://github.com/Conduit-official/Conduit/commit/cb7d782a))
- **Conversational artifacts** — Artifacts now support conversational context and can be referenced in chat ([045e9a9d](https://github.com/Conduit-official/Conduit/commit/045e9a9d))
- **MCP server gallery** — Built-in chat can now launch stdio MCP servers with one click ([b2c3d8ab](https://github.com/Conduit-official/Conduit/commit/b2c3d8ab))
- **AI diff review quick action** — Per-file and whole-tree AI diff review cards in the Git tools sidebar ([52e76ddd](https://github.com/Conduit-official/Conduit/commit/52e76ddd))
- **Per-turn RAG auto-retrieval** — Chat automatically retrieves relevant documents per turn; support for per-chat doc attachments and MCP `search_docs` ([a0635298](https://github.com/Conduit-official/Conduit/commit/a0635298))
- **Activity strip** — §3.1.6 activity strip in GitToolsSidebar ([ed35499b](https://github.com/Conduit-official/Conduit/commit/ed35499b))
- **Automation hardening** — Dual permission policies and settings improvements ([887d3364](https://github.com/Conduit-official/Conduit/commit/887d3364))
- **Mobile remote access** — E2E relay encryption (HKDF+XChaCha20-Poly1305) and Tailscale auto-serve with QR pairing ([9aed4a84](https://github.com/Conduit-official/Conduit/commit/9aed4a84), [03361f16](https://github.com/Conduit-official/Conduit/commit/03361f16), [aa7b3e4b](https://github.com/Conduit-official/Conduit/commit/aa7b3e4b))
- **Browser devtools** — New `browser_open_devtools` command to open native devtools for a browser tab
- **Conduit bundle wiring** — Interactive PTY panes now integrate the Conduit bundle ([6aae1759](https://github.com/Conduit-official/Conduit/commit/6aae1759))

### Changed
- **Chat UI** — Replaced per-message Save As / Find & Update chips with natural language controls ([4b38ded0](https://github.com/Conduit-official/Conduit/commit/4b38ded0))
- **Automation view** — Made responsive when tool panel opens ([246ca988](https://github.com/Conduit-official/Conduit/commit/246ca988), [d8c79312](https://github.com/Conduit-official/Conduit/commit/d8c79312))
- **Family connect flow** — YouTube connects standalone; slimmer toolbar chips ([254fa255](https://github.com/Conduit-official/Conduit/commit/254fa255))

### Fixed
- **Artifact creation** — `/create` now works across all providers, harness CLIs, and local models ([47ba0e86](https://github.com/Conduit-official/Conduit/commit/47ba0e86))
- **Permission policy** — Full Auto mode no longer asks for every shell command or in-roots delete ([ea4e0a96](https://github.com/Conduit-official/Conduit/commit/ea4e0a96))
- **Automation view responsiveness** — Fixed tool panel open/close behavior ([d8c79312](https://github.com/Conduit-official/Conduit/commit/d8c79312), [246ca988](https://github.com/Conduit-official/Conduit/commit/246ca988))
- **Bug audit fixes** — 26 bug and edge-case fixes from full-project audit ([c79a9e7a](https://github.com/Conduit-official/Conduit/commit/c79a9e7a))
- **Remote access binding** — Fixed relay binding to tailnet IP so phone can connect cross-network without HTTPS serve ([760bdffc](https://github.com/Conduit-official/Conduit/commit/760bdffc))
- **Remote portal QR modal** — Centered the sidebar pairing QR modal on screen ([57ca347b](https://github.com/Conduit-official/Conduit/commit/57ca347b))
- **Async serve-enable** — Added activation check for remote portal ([d9794a82](https://github.com/Conduit-official/Conduit/commit/d9794a82))
- **Family connect 400** — YouTube connects standalone; keep YouTube out of the combined Google consent ([59e2ea7d](https://github.com/Conduit-official/Conduit/commit/59e2ea7d), [d73a6d64](https://github.com/Conduit-official/Conduit/commit/d73a6d64))

### Documentation & Maintenance
- **2026-08-27 doc pass** — `PROJECT_OVERVIEW.md`, `BUG_AUDIT.md`, `PERFORMANCE_AUDIT.md`, `AI CONTEXT/AI_CONTEXT.md`, and `README.md` (new) rewritten to match the current implementation. Realized metrics: 235 IPC commands, 21 tables, 68 vitest files / 460 tests passing, 539 cargo-lib tests + 1 failed, 34 `tsc --noEmit` errors, entry chunk 458.96 KB / 141.47 KB gzip. See `BUG_AUDIT.md` for the two open Sev M items.
- **Earlier (2026-08-23) doc pass** — Updated `PROJECT_OVERVIEW.md` with current architecture and metrics — **superseded by the 2026-08-27 pass above** (the 2026-08-23 numbers no longer match the code).

---

## [0.4.1] — 2026-08-17

### Added
- **Full project audit** — 26 bug and edge-case fixes surfaced from a full codebase audit ([c79a9e7a](https://github.com/Conduit-official/Conduit/commit/c79a9e7a))

### Fixed
- **Bug audit issues** — Resolved issues across browser event paths, stream buffering, usage sync, and session id collisions

---

## [0.4.0] — 2026-08-14

### Added
- **Mobile companion app** — React Native/Expo app with E2E encrypted relay and QR pairing ([aa7b3e4b](https://github.com/Conduit-official/Conduit/commit/aa7b3e4b), [9aed4a84](https://github.com/Conduit-official/Conduit/commit/9aed4a84))
- **Remote access** — Tailscale auto-serve and portal QR modal ([03361f16](https://github.com/Conduit-official/Conduit/commit/03361f16), [57ca347b](https://github.com/Conduit-official/Conduit/commit/57ca347b), [d9794a82](https://github.com/Conduit-official/Conduit/commit/d9794a82))
- **RAG integration** — Per-turn auto-retrieval and per-chat document attachment ([a0635298](https://github.com/Conduit-workspace/Conduit/commit/a0635298))
- **AI diff review** — Quick action for per-file and whole-tree AI diff review cards ([52e76ddd](https://github.com/Conduit-official/Conduit/commit/52e76ddd))
- **Activity strip** — §3.1.6 activity strip in GitToolsSidebar ([ed35499b](https://github.com/Conduit-official/Conduit/commit/ed35499b))

### Changed
- **Chat streaming** — Improved token batching and UI flushing

### Fixed
- **Automation view** — Made responsive when tool panel opens ([246ca988](https://github.com/Conduit-official/Conduit/commit/246ca988))

---

## [0.3.x] — 2026-07 (series)

### Added
- **Permission policies** — Dual policy modes (Full Auto vs Ask) and settings improvements ([887d3364](https://github.com/Conduit-official/Conduit/commit/887d3364))
- **MCP gallery** — Built-in chat MCP server gallery with one-click install ([b2c3d8ab](https://github.com/Conduit-official/Conduit/commit/b2c3d8ab))

### Fixed
- **Shell permission prompts** — Full Auto no longer asks for every shell command ([ea4e0a96](https://github.com/Conduit-official/Conduit/commit/ea4e0a96))

---

## [0.2.x] — 2026-06 (series)

### Added
- **Artifact conversational support** — Artifacts now carry conversational context ([045e9a9d](https://github.com/Conduit-official/Conduit/commit/045e9a9d))
- **Conduit bundle integration** — Interactive PTY panes wire the Conduit bundle ([6aae1759](https://github.com/Conduit-official/Conduit/commit/6aae1759))

### Changed
- **Chat UI** — Replaced per-message Save As / Find & Update chips with natural language ([4b38ded0](https://github.com/Conduit-official/Conduit/commit/4b38ded0))

### Fixed
- **Artifact creation** — `/create` now works across all providers and local models ([47ba0e86](https://github.com/Conduit-official/Conduit/commit/47ba0e86))

---

## [0.1.x] — 2026-05 (series)

### Added
- Initial desktop shell with Tauri, multi-pane PTY, browser panes, chat, git sidebar, local models, automations, and cost dashboard.

---

**Legend:**
- 🆕 = New feature
- 🔧 = Changed behavior
- 🐛 = Bug fix
- 📚 = Documentation / maintenance
