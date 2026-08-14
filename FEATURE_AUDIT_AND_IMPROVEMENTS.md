# Conduit — Feature Audit, Improvement Roadmap & Local-Model Experience Plan

> **Date:** 2026-08-14 · **Basis:** direct read of the current source tree (157 registered IPC commands in `src-tauri/src/lib.rs`), plus `PROJECT_OVERVIEW.md`, `PERFORMANCE_AUDIT.md` (Round 2), `AI CONTEXT/BUG_LIST_ROUND2.md` (all 48 fixed), and a full competitor scan (see `COMPETITOR_ANALYSIS_AND_GAPS.md`).
>
> The PRD in `AI CONTEXT/PRD.md` is **outdated** — the shipped product is far larger than the v1 spec (chat tab with 32 tools, local GGUF models + HF market, headless CLI chat, connectors, automations, mobile companion, cost dashboard, artifacts/documents). This document audits what **actually exists today**.

---

## Part 1 — Feature-by-feature audit & how to take each to "best level"

Each section: **what exists** → **what's weak/missing** → **concrete improvements to reach best-in-class**.

### 1.1 Chat tab (the core surface)

**Exists:** 6 provider families (Anthropic, OpenAI, Anthropic/OpenAI-compatible, OpenRouter, LocalGguf) behind one trait; SSE streaming; a 32-tool loop (web_search, fetch_url, open_url, source ledger ×3, generate_file/document/diagram, run_code, run_shell, download_file, task tools ×3, `Task` subagent, 5 browser-control tools, get_skill/list_skills, 9 filesystem tools); thinking blocks; per-turn perf metrics (TTFT/tok/s persisted per message); research orchestration (`/research` with Plan/Execute/Synthesize + source ledger); context compaction for local models; typed `Channel` token streaming; Hermes fallback tool-call parsing.

**Weak/missing:**
- **No full-text search across chats.** Everything is in SQLite already; users accumulate hundreds of sessions with auto-titles. This is the single highest-leverage chat gap (also flagged in PROJECT_OVERVIEW §10).
- **No message-list virtualization** (PERF F5) — long sessions render the full DOM.
- **Message queueing exists but is subtle** — no visible "queued" affordance or reorder/edit of queued messages.
- **No conversation branching / edit-and-fork.** Regenerate exists, but editing a past user message to fork the conversation (standard in ChatGPT/Claude/Cline checkpoints) doesn't.
- **No chat export/import** (single chat or whole project) despite the local-first story.
- **Attachment limits are static** (image 5 MB, doc 10 MB) and docs are text-extracted only — no image-in-PDF/OCR path, no multi-image from clipboard batching.
- **`McpSession` re-opened every tool-enabled turn** (PERF/OVERVIEW #10) — per-turn latency + re-auth churn for connectors.
- **No per-turn wall-clock timeout** — a wedged stream can spin until the 45/96-iteration cap.
- **`parseBlocks` re-runs per streaming flip**; unstable `key={i}` in MessageBubble (PERF F6/F8).

**To best level:**
1. FTS5 index over `chat_messages` (+ titles) with a command-palette "Search all chats" result type and in-chat jump-to-match. (Small, very high value.)
2. Virtualize ChatView (e.g. `@tanstack/react-virtual`) + a "load earlier" cap.
3. Conversation fork: "edit message → new branch" using the existing `superseded_by` machinery from compaction; show branch switcher on the message.
4. Reuse MCP sessions per chat session keyed by (connector, token expiry); add configurable per-turn timeout (default 10 min).
5. Chat export/import as a zip (messages + artifacts + cost events) — completes the local-first backup story.
6. OCR/vision path for PDF pages and office docs when a vision-capable model (or local mmproj model) is selected.
7. Visible message queue chip (count, reorder, delete) in the composer.

### 1.2 Permission & approval system

**Exists:** Four modes (`read_only` / `manual` / `auto_edit` / `full_auto`) persisted per session on `chat_sessions.permission_mode`; per-session granted roots with junction/symlink-safe containment (fixed in Round 2); approval oneshot + `chat:approval-request` + `resolve_tool_action`; delete_file and run_shell always gated; connector writes gated, reads auto.

**Weak/missing:**
- `ApprovalFlow.tsx` and `PermissionModeMenu.tsx` are **dead files on disk** — the permission UI was removed; headless CLI chat always runs full-auto. The backend is fully live for built-in chat, but there is **no UI to change modes** — the most misleading gap in the product (OVERVIEW #1).
- No **per-tool or per-path memory** ("always allow write in src/"), no approval rules like Cline's auto-approve matrix.
- Headless CLI chat has **zero** approval surface — an agent can `rm -rf` inside a project with no guardrail beyond the harness's own `--dangerously-skip-permissions`.

**To best level:**
1. **Ship or remove.** Rebuild a minimal mode picker in the composer (cycle button) + approval card UI, or delete the dead files and the column. Decide per the on-hold H2 decision.
2. Approval rules engine: remember "allow once / allow for session / always allow this tool+path-glob" per session and per project; a rules editor in Settings.
3. For harness chat: intercept `run_shell`-equivalent destructive patterns via the bundle config (deny-list in the per-project harness settings) rather than blind `--dangerously-skip-permissions`, or add a per-automation permission profile.

### 1.3 Harness agents (chat-first) + optional interactive terminal panes

**How harnesses actually run (verified 2026-08-14):** the **chat view is the primary harness surface**. The composer's agent selector (`AgentMenu.tsx`) offers three agent kinds: installed CLI harnesses (`harness:<id>` — Claude Code / Kimi / OpenCode; uninstalled ones dimmed, Gemini CLI shown as a disabled placeholder), **"☁ API based"** (`builtin` — direct provider APIs), and **"🖥 Local model"** (GGUF · offline). The selection persists per chat session (`chat_sessions.agent`) and routes sends through `agent_sessions.rs` headless CLI chat — real CLI processes (Claude Code: one persistent `stream-json` process; Kimi/OpenCode: one per turn) normalized onto the same `chat:*` events, with diff/artifact detection and CLI-session resume. The ToolPanel's **terminal tab is the optional interactive surface** — the user *can* open a live PTY pane with the harness TUI there (auto-opened when launching a session from the sidebar, `sessionLauncher.ts:265-266`), but it's not required for agent work.

**Layout note:** the old Dev/Chat tab split is **gone**. Chat is the permanent full-width center surface (`App.tsx:139-148` — `ActiveView` has no `"dev"` value, `ui.ts:5`); interactive terminals and browser panes live as **tabs inside the collapsible right-hand ToolPanel** (`ToolPanel.tsx:36-45`: terminal / browser / files / canvas / agents / artifact, ≤8 tabs). Only the spotlight terminal is visible; others stay mounted-but-hidden. `GitToolsSidebar` is a floating overlay inside the chat view, and its rows open ToolPanel tabs. The old `PaneGrid` 2-col grid, `ChatBrowserSplit`, and `BroadcastBar` are **dead code** (tests only, no importers) with ~10 stale "Dev-tab" comments across `ui.ts`, `DevDiffPanel.tsx`, `ipc.ts`, `global.css`.

**Exists (PTY/harness layer — unchanged by the layout merge):** PTY panes (≤6) with xterm.js, three threads per pane, state heuristic (working/waiting/diff_ready), local-URL auto-navigation into the browser pane, session-id capture + resume for Claude Code/Kimi/OpenCode, LRU eviction, per-project harness bundle (Conduit-owned `mcp.json` + instructions, never clobbers user config), usage scraping with conservative degrade, read-time pricing with user overrides.

**Weak/missing:**
- **`pty:output` event flood** — one IPC event per 8 KB read, no batching (PERF C1, the top perf debt). Hundreds of events/sec on spinners.
- **No auto-resume on app relaunch** — panes die on quit and nothing restores them (Superset's "persistent terminals surviving restarts" is a differentiator here). Note: the **Workspaces save/restore IPC exists backend-side** (`ipc.ts:1115-1145`) but has **zero frontend callers** — a dead API, so the plumbing is half-built already.
- **Hardcoded 250 ms submit delay** in `writePtySubmit` (OVERVIEW #12).
- Kimi cross-attribution risk when two panes share a cwd (AI_CONTEXT known item).
- No find-in-terminal, no scrollback export. (Per-pane tabs/splits now exist via the ToolPanel tab model.)
- Session-id probe polls disk for 120 s — works, but fragile when harness storage layouts change.
- **Dead layout code** (`PaneGrid`, `ChatBrowserSplit`, `BroadcastBar` + ~10 stale "Dev-tab" comments) still ships and confuses every AI/code pass over the repo.

**To best level:**
1. Batch `pty:output` into 16 ms / N-byte coalescing buffers; move ANSI strip + URL scan off the hot path (PERF C1 fix).
2. **Restore-on-launch:** wire the existing Workspaces IPC to the frontend — persist pane layout + session ids; on start, offer "restore 4 panes?" — resume-by-id makes this cheap and matches Superset's key selling point.
3. Terminal UX pack: find-in-terminal (xterm search addon), scrollback-to-file, per-tab title editing in the ToolPanel.
4. Replace the 250 ms sleep with an output-quiescence check (e.g. fire submit when no output for 80 ms, capped 2 s).
5. Surface the state heuristic in the sidebar (already partially there) + a global "N panes waiting for you" badge in the title bar/taskbar.
6. **Delete the dead layout code** (PaneGrid grid render, ChatBrowserSplit, BroadcastBar — or re-implement broadcast against ToolPanel tabs if multi-agent fan-out is still wanted) and sweep the stale "Dev-tab" comments.

### 1.4 Browser panes & agent browser control

**Exists:** Native child webviews per tab (Win/macOS), standalone windows on Linux; tab bar + URL bar + history; Readability-based extraction with 4 read modes, consent dismissal, `data-conduit-ref` element refs; 11 MCP browser ops + 5 conduit-tools via the `conduit-browser-mcp` sidecar; visual feedback layer (cursor tween/ripple/caret) with watch-mode pacing.

**Weak/missing:**
- **`browser_capture.rs` Windows screenshot is a stub** — `browser_screenshot` is degraded on the primary platform.
- **Known intermittent bug:** `browser_action_result` reachability in child webviews (navigate returns empty, read_page 15 s timeouts) — AI_CONTEXT §168.
- Hard-coded 1.5 s sleep before pushstate injection (PERF B9).
- No devtools, no network/console inspection, no device emulation (Vibe Kanban had these).
- No multi-window/pop-up handling strategy; downloads inside webview unhandled.

**To best level:**
1. Finish WebView2 `CapturePreview` — screenshot is table stakes for an agent-browser.
2. Fix the `browser_action_result` capability/allowance issue (root-cause the 15 s timeouts); add a self-test command that round-trips one navigate+read on startup diagnostics.
3. Replace the 1.5 s sleep with a readiness poll on `document.readyState`.
4. Add a minimal devtools panel (console log capture + network request list) — huge agent-debugging value, moderate cost via WebView2 devtools protocol.
5. Download manager for webview-initiated downloads into the artifacts dir.

### 1.5 Git tooling

**Exists:** Floating git-tools overlay inside the chat view (changes, branch dropdown with log graph, commit modal with AI-generated Conventional-Commits message + dedicated fast-model picker, plans section, progress — its rows open ToolPanel tabs); worktrees; filesystem watcher replacing polling; path-traversal-hardened diffs; "Send PR" deliberately delegates to the harness.

**Weak/missing:**
- **No GitHub PR creation/review from the app** — the connector exists (GitHub OAuth) but the git sidebar can't open a PR, see PR status, or review one. Competitors (Vibe Kanban, Nimbalyst, Codex, Jules) are PR-centric.
- `BranchPanel.tsx` is explicitly "Phase 1" placeholder.
- `useGitStatusPolling` name is stale (event-driven now); DevDiffPanel still 4 s-polls alongside the watcher.
- No stash, no stage/unstage granularity (it's `git add .` only), no conflict resolution UI, no blame/log file history.

**To best level:**
1. **PR flow via the GitHub connector:** create PR (push + `gh` fallback), list open PRs per project, show CI/check status, and a review surface (diff + comment → posted via connector). This closes the loop the git sidebar currently leaves open.
2. Stage-level control: checkbox staging in Changes view (porcelain already parsed), stash push/pop list.
3. Finish BranchPanel (switcher + graph) or fold into BranchDropdown and delete the stub.
4. Rename `useGitStatusPolling` → `useGitStatusEvents`; unify DevDiffPanel onto `project:fs-changed`.

### 1.6 Connectors

**Exists:** 11 registered connectors (Notion, Gmail, 7× Google Workspace, GitHub, Kiwi), OAuth2+PKCE through the system browser, RFC 7591 dynamic registration, transparent token refresh, remote-MCP via rmcp with per-turn schema merge, Read/Write classification with write-gating, REST fallbacks for the Google MCP developer-preview gap, per-conversation opt-in, harness passthrough into `mcp.json`. Canva built but disabled (vendor waitlist).

**Weak/missing:**
- Token freshness for persistent Claude processes (~1 h bearer expiry until respawn — OVERVIEW #9).
- OAuth client secrets baked into the binary via `option_env!` (acknowledged debt).
- No Slack/Linear/Jira/Discord/Notion-database connectors — the registry is generic, each addition is mostly config.
- No connector health dashboard (token expiry, last error, re-auth one-click).
- MCP sessions re-opened per turn (see 1.1).

**To best level:**
1. MCP session reuse + pre-turn token refresh for harness passthrough (re-snapshot `mcp.json` on expiry).
2. Move OAuth client config to a dynamic endpoint or build-time config file; get secrets out of the binary.
3. Ship 4–6 more connectors (Slack, Linear, Jira, Discord, Airtable, Notion databases) — pure leverage on the existing framework.
4. Connector status page: per-connector token state, last MCP call result, "reconnect" button.

### 1.7 Automations

**Exists:** Cron scheduler (30 s tick), headless one-shot turns logged to per-automation chat sessions, overlap-skip with cross-process lock files (6 h stale self-heal), missed-window catch-up, standalone `conduit-automation` binary for Task Scheduler/cron, run ledger + run-now.

**Weak/missing:**
- **The Task Scheduler registration is literally "the only piece left to add"** — the binary ships but nothing registers it, so "runs while closed" requires manual user setup.
- No completion **notifications** (the app may be closed — that's the point!). No email/webhook/desktop-toast on failure.
- Kimi harness rejected for automations (documented, fine) — but no UI explanation when a user picks it.
- No run diff/summary view beyond the chat transcript; no retry policy; no per-automation budget cap.
- Editing a non-preset cron is fixed (Round 2 A14) but cron UX is still expert-only.

**To best level:**
1. **One-click "Run while closed" toggle** that registers/unregisters the Windows Task Scheduler entry (and launchd/cron on other platforms) — this completes the feature's core promise.
2. Notification plumbing: Windows toast on completion/failure when the app is open; optional webhook URL + email-via-Gmail-connector when closed; mobile push via the relay when a phone is paired.
3. Automation detail page: next run countdown, last N runs with status/duration/cost, one-click "open transcript", failure retry button.
4. Natural-language schedule input ("every weekday at 9am" → cron) with preview of next 3 fire times.
5. Per-automation spend/token cap that auto-disables with a loud notice.

### 1.8 Mobile companion

**Exists:** RN/Expo app, loopback/LAN WS relay with per-launch pairing token + QR pairing, sessions-as-chat UX, transcript mirroring (SGR-styled, cols/rows aware), spawn/create session from phone, chat turns (incl. local GGUF warm-up), approvals from the phone, cost summary/details, inbox badges for waiting/diff_ready.

**Weak/missing:**
- **Per-token `setState`** during streaming (PERF C6) — 50–200 renders/sec.
- **5 s poll fires `GetCostDetails`** — 3 SQL aggregations under the DB mutex per tick (PERF C4/C5).
- **`build_available_providers` probes 11 endpoints sequentially** — up to ~40 s blocking the WS reply (PERF C7).
- **Hardcoded dev-machine default URL** `ws://192.168.1.7:52506` in `useRelay.ts`.
- **Attachments not processed** on mobile sends (`session_chat.rs:283`).
- Relay binds `0.0.0.0` by default (LAN-reachable; OVERVIEW #11).
- No push notifications (phone must have the app open), no E2E encryption (Happy Coder's differentiator), no offline queue, iOS untested vs Expo limits.

**To best level:**
1. Fix the three perf items (batch tokens via rAF; cost-details on demand; `join_all` + 5 s cap on provider probes). These are P1 — they make the phone feel broken on real networks.
2. Remove the hardcoded IP; last-known-good + mDNS/QR-only discovery.
3. Default bind to `127.0.0.1` with an explicit "Allow LAN" toggle; rotate + re-emit pairing token.
4. Implement attachment pipeline (base64 over WS is fine at these sizes) — the protocol field exists.
5. Medium-term: local push via a tiny always-on notification when relay detects `waiting`/`diff_ready`/automation events (Android foreground service; iOS needs a different story — be honest about it in docs).

### 1.9 Settings / Skills / Cost / Palette / Onboarding

**Exists:** 9 settings categories (appearance, assistant, API keys, local models, pricing overrides, harnesses with login runner, git, connectors, data locations); skills library (skills/loops/templates, dual-root discovery, built-in docx/pptx/pdf/diagram/goal/loop); full cost dashboard (hero cost, per-provider, 7/30/90d charts, cache savings, cost-quality panel); Cmd+K palette; workspaces (save/restore layouts); onboarding banner; updater banner with markdown changelog.

**Weak/missing:**
- No toast/notification surface — most IPC errors die in `console.warn` (OVERVIEW Improvements #2).
- Quick-action keybindings stored but **never registered** (AI_CONTEXT §5.3).
- Static pricing/model catalogs with drift risk (OVERVIEW #5).
- No global search (see 1.1).
- Modal has no focus trap/ESC (a11y, OVERVIEW #14).
- First-run experience is a banner, not a guided setup (no "add project → pick harness → first session" flow).

**To best level:**
1. Global toast system wired to a standard `safeInvoke` error path — one weekend, transforms perceived reliability.
2. Register quick-action keybindings (Tauri globalShortcut behind an opt-in).
3. Guided first-run flow (3 steps) + a sample automation suggestion.
4. Modal a11y pass (focus trap, ESC, `aria-modal`) — cheap.
5. Settings search box (jump to category/field) — 9 categories and 1967 lines of SettingsView need it.

### 1.10 Distribution / updater / build

**Exists:** Signed NSIS auto-updates from GitHub Releases (`latest.json`), startup + 4 h checks, changelog banner, CI build+release pipeline with bundled Python/LibreOffice/llama-server staging.

**Weak/missing:**
- **CI never runs the test suites** — 383 Rust tests + 226 vitest tests exist but a regression can ship straight into a signed release (OVERVIEW Bugs #2).
- **Windows-only distribution** — code is cross-platform (Linux browser panes, macOS vibrancy all exist), but no macOS/Linux build jobs, and bundled Python/LibreOffice fetch scripts are Windows-only. Every orchestrator competitor is Mac-first — but the broader market (and all of Cursor/Claude Code/Zed) ships everywhere; Conduit's own user is on Windows, so this is a *growth* decision, not a defect.
- No manual "Check for updates" button; no stable/beta channels.
- Placeholder 32×32 app icon (AI_CONTEXT known item).

**To best level:**
1. Add `cargo test` + `vitest run` as a required CI job gating the release job.
2. Manual update check + release-channel setting.
3. When growth matters: macOS build job is the highest-ROI platform addition (the whole orchestrator competitor set lives there); requires staging macOS Python/LO fetch scripts.
4. Real app icon set.

---

## Part 2 — Local-model experience: the dedicated improvement plan

Conduit's local-model stack is already more integrated than any orchestration-shell competitor (HF market + GGUF scan + llama-server sidecar + GPU ladder + compaction + vision). But "best experience" means rivaling **LM Studio's polish** while keeping the agent tooling nobody else has. Gaps, ranked:

### 2.1 Onboarding & model selection (biggest UX gap)
- **Today:** user must know what a GGUF/quant is; market cards show size badges but no guidance; binary resolution prefers a hardcoded personal path `D:\llama-cuda\llama-server.exe` (`local_models.rs:800-940`).
- **Fix:**
  1. **"Recommended for your machine" row** in the market: use the existing DXGI/NVML probes to suggest 3 models (e.g. "Qwen3-8B Q5_K_M — fits your 12 GB VRAM with 32k ctx"). AnythingLLM and LM Studio both do hardware-aware picks; Conduit has the probes already.
  2. Plain-language quant explainer chip ("Q4_K_M = good balance, ~5 GB") on every market card.
  3. Remove the personal-machine path hacks from the shipped resolution order; ship the sidecar as the default on all platforms and document `LLAMA_SERVER_PATH`.
  4. First-local-model wizard: detect RAM/VRAM → offer one-click download of a sane default → auto-start → drop into chat.

### 2.2 Runtime performance
- **Per-turn `/tokenize` round-trips (3–4)** before/within compaction (PERF B1) — 100–400 ms dead time per local turn. Fix: cache counts per turn, single pass.
- **Sidecar cold start** blocks the first turn 5–60 s. Fix: keep-alive with idle timeout ("unload after 15 min idle" setting), warm-on-select option, and a visible "warming up" progress state (currently a spinner only).
- **No speculative/NGL tuning exposed.** Fix: an "Advanced" popover (ctx size — already there, threads, batch size, flash-attn flag, mmap/mlock) persisted per model.
- **VRAM probing is NVIDIA-only for free VRAM**; AMD/Intel fall back silently. Fix: DXGI-free-memory path where possible, else show "unknown" honestly rather than a wrong badge.

### 2.3 Capability gaps vs LM Studio / Ollama / Jan
1. **No model switching mid-session** without a restart dance; multi-model keep-alive (map already supports N — v1 stops the old one deliberately). Offer "keep last 2 models warm" when VRAM allows.
2. **No embeddings/RAG over local docs** — GPT4All LocalDocs and AnythingLLM define this category. A `LocalDocs`-style feature (embed a folder with a small GGUF embedding model via llama-server `/embedding`, SQLite vec table, ground chat answers) is the single biggest local-model feature Conduit lacks, and it composes with the existing filesystem tools + source ledger.
3. **No local speech/STT/TTS** (LM Studio Bionic has local voice transcription; Happy has voice). llama-server won't do it, but a whisper.cpp sidecar is the same operational pattern Conduit already ships.
4. **No benchmark/feedback**: users can't tell if their model is fast. The per-turn perf metrics exist — add a local-model "health card" (tok/s rolling average, ctx usage, offload level actually achieved vs requested).
5. **Model update notifications** — HF catalog entries change; "a newer Q4_K_M of your model exists" is a delight feature LM Studio users love.

### 2.4 Reliability & honesty
- OOM ladder exists (999→64→…→0) but each step is a full spawn — cache the highest working NGL per model so the second launch is instant.
- Context tiering by file size is crude (32768/16384/8192); combine with GGUF metadata `context_length` and VRAM probe to pick the *largest* ctx that fits, and tell the user what was chosen and why.
- The `requires_local_sandbox` capability is plumbed but unused (`tools/mod.rs:157`) — either implement the sandboxed-exec path for local models (they need *more* guardrails, not fewer, since small models tool-call sloppily) or remove the flag.
- `web_search` is stripped for local models — good — but there's no offline substitute; consider an opt-in SearXNG/localhost search pointer.

### 2.5 Vision
- mmproj auto-detection + pairing exists (fixed in catalog, recent commit). Missing: **screenshots/images actually flowing to local vision models in the chat UI path** (vision flag exists on `GgufFile`; verify the providers path sends image blocks to the local OpenAI-compatible endpoint — if not, wire it), plus a "take screenshot → ask local model" shortcut using the browser capture (once 1.4.1 lands).

---

## Part 3 — New features to implement (ranked by leverage × fit)

| # | Feature | Why now | Effort |
|---|---|---|---|
| 1 | **Full-text search over everything** (FTS5: chats, artifacts, plans) + palette integration | Data is already local; competitors' search is weak; daily-use feature | S |
| 2 | **Global toast/error surface** | Perceived reliability; prerequisites nothing | S |
| 3 | **Restore panes on launch** (persistent workspaces) | Superset's headline feature; resume-by-id makes it cheap — and the Workspaces IPC already exists backend-side with no frontend callers | S–M |
| 4 | **PR create/review via GitHub connector** | Completes the git loop; every orchestrator competitor is PR-centric (T3 Code ships 4-provider PR review tabs) | M |
| 4b | **Per-turn checkpoints + one-click revert** (hidden git refs; restore workspace + conversation) | T3 Code & Cline ship this; Conduit has zero turn-level undo — biggest safety gap once agents edit code from chat | M |
| 5 | **Automation notifications + Task Scheduler registration** | Completes the "runs while closed" promise already 90% built | S–M |
| 6 | **LocalDocs-style local RAG** (embedding sidecar + vec table) | Defines the local-model category; composes with existing tools | M |
| 7 | **Chat export/import + project backup zip** | Local-first story completion | S |
| 8 | **Approval rules engine** ("always allow tool+glob") | Cline-level ergonomics on the permission system | M |
| 9 | **Conversation branching/fork** | Table stakes in 2026 chat UIs; `superseded_by` machinery exists | M |
| 10 | **Budget/spend alerts** (per project/month, toast + mobile) | Cost dashboard exists; alerting is the natural next step | S |
| 11 | **VRAM-aware market recommendations** | Probes exist; pure UX leverage | S |
| 12 | **More connectors** (Slack, Linear, Jira, Discord) | Framework is generic; config-level cost | S each |
| 13 | **Terminal find + scrollback export** | xterm addons; pure frontend | S |
| 14 | **Prompt template library with variables** (generalize QuickActions) | Existing primitives; multi-turn templates | S–M |
| 15 | **Webview devtools panel** (console + network) | Agent debugging superpower; WebView2 CDP | M |
| 16 | **Whisper sidecar for voice input** (desktop + mobile) | Same sidecar pattern as llama-server | M |
| 17 | **Pop-out chats/panes into windows** | Tauri multi-window proven (Linux browsers) | M |
| 18 | **Multi-chat "team" broadcast** (send one prompt to N chat sessions) | The old pane BroadcastBar is dead code post-layout-merge; rebuild broadcast against chat sessions / ToolPanel tabs | M |
| 19 | **Theme import (JSON)** + theme gallery | Token system is data-driven | S |
| 20 | **ACP client support** (talk to Zed/Devin-ecosystem agents) | Emerging standard; future-proofs the shell | L |

---

## Part 4 — Cross-cutting engineering debt that gates "best level"

(From PERFORMANCE_AUDIT Round 2 — still open and user-visible.)

1. **C1 pty event batching** — biggest perceived-snappiness fix in the app.
2. **C6/C4/C7 mobile perf trio** — the companion app currently undermines the flagship differentiator.
3. **B1 tokenize round-trip collapse** — biggest local-model latency fix.
4. **C9/global.css 9.9k lines** — freeze + Tailwind migration policy; extract tokens to `theme.css`.
5. **CI test gate** — cheap, protects everything above.
6. **F5 list virtualization** across chat/sidebar/artifacts/mobile.
7. **`run_code` OS sandboxing** (Job Object on Windows; landlock/macOS profiles already TODO'd) — security posture for a tool that executes model-written code.
8. **Kill the remaining personal-machine assumptions** (`D:\llama-cuda`, `ws://192.168.1.7`) before any wider distribution.

---

*Generated from a full source-tree read on 2026-08-14. Companion document: `COMPETITOR_ANALYSIS_AND_GAPS.md`.*
