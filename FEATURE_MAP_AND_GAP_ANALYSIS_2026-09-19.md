# Relay — Full Feature Map & Gap Analysis (2026-09-19)

> Point-in-time analysis of the entire product: every feature mapped from the code, cross-checked
> against existing audits (`docs/audits/`, `CODEBASE_AUDIT_*`), and against the September 2026
> competitive landscape (coding agents, AI chat/local-LLM desktop apps) and agent-ecosystem
> standards (MCP, A2A, Agent Skills, OTel). Items marked **[code]** were verified in the codebase;
> items marked **[research]** come from external research and should be re-verified before building.

---

## 1. Executive summary

Relay is in an unusually strong and clean state: four audit waves fully remediated, no open Sev-1
bugs, ~339 backend commands across 16 subsystems, a 17-section settings surface, 163 frontend test
files, and several features **no competitor ships** (agent-controllable native browser panes, a
GGUF model market with one-click local serving, Session Mesh peer-to-peer agent messaging,
run-while-closed local automations, self-improving artifacts, a cross-agent cost dashboard).

The gaps cluster into six themes, in rough priority order:

1. **Trust & safety** — model-authored code runs with full user privileges (no OS sandbox); the
   installer is unsigned; budgets are advisory-only. This is the single biggest blocker to
   honestly selling `full_auto` and to distribution growth.
2. **Ecosystem drift** — MCP moved to a stateless 2026-07-28 spec with MCP Apps, a registry, and
   tool annotations; Agent Skills (SKILL.md) became an open standard; A2A hit v1.0. Relay is a
   2025-generation MCP client and has partial skills support.
3. **Table-stakes parity** — hooks (pre/post tool events), triggers beyond cron, declarative
   named subagents, shareable trace/session links, cloud-burst execution (currently a deliberate
   non-goal), inline per-hunk edit review.
4. **Quality ceilings** — RAG is brute cosine with no reranking/hybrid fusion; web search is
   scraping-based; one local model served at a time; no local vision/audio input path in chat UX.
5. **Platform reach** — Windows-only shipping (no macOS .dmg / Linux packages), degraded Linux
   browser + secrets + OCR, mobile companion is read/control-only with no task dispatch.
6. **Engineering hygiene** — CI runs no tests, no clippy, entry-chunk bloat, unregistered
   keybindings, stale pricing table, orphaned components.

Sections 5–7 turn these into a prioritized, effort-tagged backlog.

---

## 2. Product snapshot

| Fact | Value |
|---|---|
| Product | Relay — local-first, multi-pane desktop shell for AI coding agents |
| Stack | Tauri v2 (Rust), React + TypeScript + Zustand, SQLite (WAL, ~46 tables), React Native/Expo mobile |
| Platforms shipped | Windows (NSIS installer); macOS/Linux compile-only |
| Test surface | 163 vitest files (~1,055+ tests), `cargo test --lib` 1,078 passed, `tsc --noEmit` clean |
| Backend surface | ~339 registered Tauri commands, 30+ ALTER-style DB migrations |
| Agent tools exposed to models | 45+ built-in tools (see §3.13) plus vendor MCP/connector tools |

---

## 3. Complete feature map (what exists today, verified in code)

### 3.1 App shell & navigation **[code]**
- Custom window chrome (drag title bar, min/max/close), collapsible sidebar, browser-style back/forward view history, `Ctrl +/-/0` chat-text and whole-app zoom, UI/mono font pickers, dark/light/system + importable JSON theme gallery with presets and export.
- Views: Chat (always mounted), Automations; overlay surfaces: Settings (17 sections), Skills Library, Cost Dashboard, Command Palette (`Ctrl+K` fuzzy over sessions/projects/actions + FTS5 full-text chat search).
- Pop-out chat windows (`?popout=chat&session=<id>`); per-project workspace pane-layout autosave/restore across restarts.
- Notification center: durable bell + unseen count across restarts, deep-linking rows (turn finished, approvals waiting, automation runs, budget alerts, model downloads, harness updates), funnel center → OS toast (DND-gated, correct Windows AppID) → chime (focus-gated).
- Auto-updater (boot + every 4h) with release-notes modal and download progress; sidebar update pill.
- Onboarding: 5-step Welcome Wizard (replayable), harness-missing banner, first-run local-model nudge, worktree migration nudge.

### 3.2 Chat experience **[code]**
- **Built-in chat** with Anthropic, OpenAI, OpenRouter, Anthropic-compatible, OpenAI-compatible (multiple named endpoints per kind) and local GGUF via llama-server; reasoning-effort/thinking toggles; prompt caching (3 Anthropic breakpoints); streaming with silence-watchdog reconnect ladder; per-turn performance HUD (input/output tokens, LLM/tool time, TTFT, tok/s, cache-hit rate); context meter with per-model window registry and live `/tokenize` counts for local models; compaction for local (pin+summarize) and cloud (estimate + overflow retry) paths.
- **6-pane split workspace**: recursive binary split tree, drag-session-onto-edge with outcome preview, LRU-replace modal, per-pane buffers/composers/HUDs, layout memory.
- **Composer**: attachments (file picker, paste-to-attach incl. screenshots, drag-and-drop, docx/pptx/xlsx/pdf server-side extraction), working-folder override per session, one-shot research mode chip, thinking 3-state, slash menu (skills, prompt templates with variable-fill forms, `/compact`, `/research`, `/create`), `@` connector/MCP attach pills per message, FIFO message queue with Steer/Edit/reorder, quoted selections, push-to-talk dictation with live waveform, per-session drafts.
- **AgentModelPicker**: harnesses, ACP agents, local models, cloud endpoints; effort slider; auto-routing bias (Quality/Balanced/Economy — Phases 0–3 shipped); local-model load gear with drafted overrides and VRAM eject.
- **Message view**: Claude-style collapsible "Working…" process blocks (thinking disclosures, tool rows, live shine), DiffCards per write, TurnChangesRow with per-turn Undo (checkpoint restore), artifact chips, PlanBanner + plan approval cards, interactive citations with lint verdicts and one-click fix, KaTeX math, GFM tables, Mermaid + inline SVG/HTML/JSX artifact previews (sandboxed), diagram lightbox, read-aloud (Kokoro), edit-to-fork, regenerate, delete, compacted-context markers, RTL `dir=auto`.
- **Permission system**: read_only / plan / manual / auto_edit / full_auto postures (+ harness-native catalogs), composer glow, plan-mode mutation gating, approval cards for gated tools and `present_plan`, user approval rules (tool+path glob, never widening path scope), native out-of-webview exec gate for arbitrary-execution surfaces.
- **Plan mode & goals**: `todo_write`/`enter_plan_mode`/`present_plan`, plan Canvas tab, goal-loop card with iteration timer (`/goal`, `/loop`).

### 3.3 Agent harnesses (PTY) **[code]**
- Up to 6 PTY panes wrapping **Claude Code, Kimi Code, OpenCode, Pi, OMP, CommandCode** with per-harness adapters (session-id capture, resume-by-id, login flows, native update via npm/winget, usage scraping priced via read-time price table).
- Headless CLI chat sessions normalized to chat events (persistent Claude stream-json; per-turn spawn wrappers for the other five), with post-hoc DiffCards, RELAY_ASK question channel, subagent tracker + Agents panel.
- **ACP client** (JSON-RPC over stdio) for Zed-ecosystem agents (zed, devin + user-defined).
- Relay-owned per-project harness config bundle (instructions, permissions, MCP registration) that never clobbers user CLI configs; harness model/endpoint discovery from each CLI's own config.

### 3.4 Native browser panes **[code]**
- Real child webviews (WebView2/WKWebView; Linux separate-window fallback) with multi-tab browsing, occlusion system so popovers never get painted over, per-pane history, zoom, find, devtools, clear-site-data, print-to-pdf.
- **Agent control**: click/type/scroll/hover by ref, fill_form, select_option, press_key, snapshot/read_page (cleaned Markdown + ref map), observe, extract, evaluate JS, wait_for, tab management, batch ops, screenshot, console/network reads, cookie-banner dismissal.
- **Trust layer**: URL gates, pause/stop, credential-takeover confirmations, user-owned action timeline, agent-active indicator, watch mode pacing.
- **`relay-browser-mcp` sidecar**: standalone stdio MCP server + CLI exposing the real visible panes to any harness via loopback WS (28 operations); per-project `.mcp.json`/config registration at spawn.

### 3.5 Git & GitHub **[code]**
- Git sidebar: status, diff (whole/file/scoped), branch CRUD + search, commit/commit&push/push modal, log, ahead/behind, **worktrees** (create/remove + per-chat-session worktrees `relay/<id8>`), Git Graph commit table, FS-watcher driven refresh (no polling).
- **Per-turn checkpoints** across all agents (hidden refs `refs/relay/checkpoints/…`) with one-click Undo + safety snapshot.
- Pull Requests panel: list/detail/review (submit review)/create with LLM-drafted text/checks via GitHub connector OAuth.

### 3.6 Local models & media **[code]**
- **Model Market**: Hugging Face GGUF browse/search/download (resumable, SHA-256 verified, optional HF token in keychain), VRAM/RAM fit badges, quantization info, mmproj download.
- llama-server sidecar management: metadata parsing, memory sanity checks, per-model overrides (n_ctx, n_gpu_layers, flash-attn), auto-NGL probing, warmup, `/tokenize` context counts, electricity-rate + GPU-watts local cost estimation. One chat sidecar at a time (v1 policy); separate embedding sidecar for RAG.
- **STT**: whisper.cpp sidecar, curated GGML catalog incl. large-v3-turbo-q5, one-click CPU/CUDA installs, auto-start.
- **TTS**: Kokoro-82M in-process (sherpa-onnx, 11 voices, auto-read mode, preload); Windows CUDA child-process path.
- **Image generation**: stable-diffusion.cpp `sd-server` sidecar (Z-Image-Turbo-GGUF/SD1.5 catalog, family plans, device selection), live ImageGenCard in chat.
- **Vision**: images accepted by cloud providers; local GGUF mmproj projector support in sidecar launch.

### 3.7 Documents, artifacts & self-improvement **[code]**
- **Document generation**: `generate_document` (docx/pptx/xlsx/pdf via bundled Python or sandboxed JS engine), `plan_document` (structured plan → compiled deck/doc against a named design system + L1 QA + pdf.js render probes), `revise_document` (patch-based), accurate pptx→pdf via bundled LibreOffice, faithful office→HTML preview.
- **Artifact library**: 30-day retention, grid modal with snippet thumbnails, jump-to-originating chat, delete.
- **Self-improving artifacts**: eval packs + failure sweeps → GEPA-style proposals from the active chat model → deterministic + blind-LLM-judge evaluation → gated promote/rollback, channels, autonomy tiers (manual → autonomous), canaries, per-artifact feedback attribution.
- **Diagrams**: Mermaid 11.17 + ELK, per-theme palettes, 1–4× PNG export.
- **Other artifacts**: generate_file (downloadables), generate_image, generate_diagram, conversational artifact proposals (`/create` → skill/loop/prompt-template/automation).

### 3.8 Memory **[code]**
- Persistent memory with extraction (evidence-backed), LLM-judge consolidation (ADD/UPDATE/DELETE/NOOP, bi-temporal supersession), generative reflection (cited insights), hybrid retrieval (vector ∪ FTS5 → fusion → MMR), one human-readable memory document (2,200-token budget) with version history, per-turn injection (800-token budget), configurable extraction model, offline eval fixtures (recall@8 ≥ 0.85, ≥95% contradiction handling).
- **Memory Panel**: document editor + restore, fact list by kind (Identity/Preference/Episode/Feedback/Project-scoped), search, self-added facts, delete, purge, export.

### 3.9 Session Mesh **[code]**
- Cross-session awareness for both built-in chat and harness CLIs (via the `relay-tools` MCP bridge): `list_sessions`/`read_session`/`search_sessions` (peer registry, summaries, FTS over all chats), `message_session` (mailbox, answers return as tool result or follow-up turn), `spawn_session` (real sidebar-visible child sessions on any engine).
- Mail audit trail, session summaries distillation, hard caps (8k chars, 10 msgs/hour, queue 5, spawn depth 2, 3 children/parent/24h, 8 active), plan-mode refusal + permission gating.
- Mesh rail in the git sidebar: mail rows + spawned children with jump-to-session.

### 3.10 Research mode **[code]**
- Plan/Execute/Synthesize scaffolding, evidence-sufficiency gate (`check_sufficiency`), source ledger (`add_source_note`/`get_source_ledger`), mechanical citation lint + async LLM verification + one-click fix, SERP via keyless DDG/Mojeek/Wikipedia + browser-pane SERP for bot walls + optional Brave/Serper/Tavily keys, SERP/page caches (12h/7d; Brave never persisted).

### 3.11 Automations **[code]**
- Cron automations firing as headless one-shot agent turns (full tool access, forced full-auto with one-time confirmation), runs logged into their own chat sessions, overlap-skip with records, PID + lock-file guards.
- **Run while closed** via Windows Task Scheduler sidecar (`RelayAutomations`, every minute; identical due-math).
- Notifications on completion (bell + Expo push when paired), run-finalize **webhook POST** with test button, failure email via SMTP, past-runs table.

### 3.12 Connectors, MCP & skills **[code]**
- **OAuth connectors** (PKCE in system browser, tokens in OS keychain, per-conversation opt-in attach): Notion, Gmail, Google Drive/Docs/Sheets/Slides/Calendar/Chat/People, YouTube, Kiwi, GitHub, Canva; Google family one-token connect; REST fallbacks for Google tools the hosted MCP gates.
- **MCP client**: stdio gallery (filesystem, memory, sequentialthinking, everything, fetch, git, sqlite, time + custom command/env entries behind the exec gate), global tool exposure as `mcp_<server>_<tool>`, attach-on-demand for connector/MCP vendor tools, read/write classification with write-approval gating.
- **`relay-tools` MCP bridge**: 21 Relay-native tools (documents, automations, skills, mesh, RAG, capabilities) exposed to harness CLIs, with compile-time registry↔bridge exhaustiveness checking.
- **Skills Library**: reads SKILL.md skills + loops from `~/.claude/skills` + `~/.agents/skills`, editable in place, writes to both roots; DB-backed prompt templates; `get_skill`/`list_skills` tools; slash-command integration.

### 3.13 Built-in agent tool registry **[code]** (45+ tools)
Read-only: `web_search, fetch_url, open_url, browser_read, browser_screenshot, browser_observe, browser_extract, generate_file, generate_document, plan_document, revise_document, generate_diagram, generate_image, get_skill, list_skills, list_artifacts, get_capabilities, attach_connector, attach_mcp_server, add_source_note, get_source_ledger, reset_source_ledger, check_sufficiency, todo_write, enter_plan_mode, present_plan, list_directory, read_file, search_files, search_content, search_docs, totp_code, list_automations, list_sessions, read_session, search_sessions, Task, get_task_status, cancel_task, browser_click/type/scroll (cap)`.
Mutating (gated): `write_file, edit_file, move_file, copy_file, delete_file (always approved), download_file, run_shell (always approved), open_file, run_code (cap), create/update/delete_automation, run_automation_now, message_session, spawn_session, memory_save/recall/forget (cap)`.
Subagents: `Task` spawns read-only-tool subagents (100-round cap, alternate-model capable, Agents panel streaming).

### 3.14 Knowledge (local RAG) **[code]**
- Corpus management (add folder, enable, attach to chat), mtime/size-diff incremental walk, chunking, image surrogates (Windows.Media.Ocr on Windows; optional vision caption; filename fallback), batch embeddings via local sidecar, `search_docs` tool with path/type/score + excerpts, indexed progress events, brute cosine + FTS.

### 3.15 Cost & budgets **[code]**
- Cost dashboard: range toggles, daily chart, cache-savings emphasis, per-model breakdown (cached/uncached in/out, provider-reported vs processed), per-harness attribution incl. local models at $0; per-project monthly budgets with spend bars, alert bell/toast/OS notification/Expo push (advisory only); mobile cost mirror.

### 3.16 Mobile companion **[code]**
- Expo app: QR/`relay://` pairing (token = PSK, HMAC proof, HKDF → XChaCha20-Poly1305 E2E frames), loopback + USB bridge + Tailscale serve transports, Expo push fallback.
- Chat from phone: history drawer (day-grouped, search), new-chat with project+harness pick, streaming with thinking/tool rows, attachments, **voice memo → desktop whisper transcription**, approvals (Approve/Deny/Always-allow), plan proposals (approve/revise), model picker incl. starting desktop local models, rename/delete, artifact sheet (JSX/text/image + save/share for pdf/docx).
- Settings: connection, appearance, push, biometric app lock, cost summary + 14-day bars + per-project totals + budget alerts.

### 3.17 Platform plumbing **[code]**
- Secrets split: key names in SQLite, values in OS keychain (with pre-rebrand migration); pre-rebrand data-dir migration; Linux XOR-obfuscated fallback.
- Exit cleanup kills all children (PTYs, webviews, llama/whisper/sd servers, TTS, relay, MCP children) with time bounds; partial-stream persistence on quit; crash-recovery reconciliation.
- Resumable download pump with cancel/stall watchdogs (shared by `download_file` tool + HF market); TOTP via keychain/Bitwarden/1Password CLI; dev visual harnesses + `tauriStub`; CSP with pinned `connect-src` + cdnjs contract asserted by tests.

---

## 4. Gap analysis

### 4.1 Trust & safety (highest consequence) **[code]**
1. **No OS sandbox anywhere in the exec path.** `run_code`, `run_shell`, pygen document builds, and MCP-gallery custom servers run with full user privileges; the `apply_sandbox` hook is reserved but unwired (`chat/codeexec.rs:100/110/131` TODOs for Landlock / sandbox-exec / Windows Job Object). Competitors ship this by default: Codex has a native Windows restricted-token sandbox (shipped May 2026 **[research]**), Claude Code has seatbelt/bubblewrap bash sandboxing **[research]**. Until this lands, `full_auto` and unattended automations carry silent risk.
2. **Unsigned installer / distribution trust.** No Authenticode signing → SmartScreen/AV friction; updater signing exists only **[code + research]**. No winget/Scoop presence **[code]**.
3. **Unattended full-auto authority.** Automations force `full_auto` (and `--dangerously-skip-permissions` for Claude); the "authority story" is a documented open decision **[docs]**. Budgets are advisory-only — nothing hard-stops a runaway run **[code]**.
4. **Exec-gate remembered approvals live in plain `app_settings`** (hashed idents, unauthenticated) — a DB writer could pre-allow execution **[code]**.
5. **Pairing proof is replayable** (static HMAC over token); needs a coordinated challenge-response release **[docs]**.
6. **Linux secrets are XOR-obfuscated, not encrypted** **[code]**.
7. **Harness bearer tokens sit in plaintext project `mcp.json`/`opencode.json`** (CLI-required; needs env-var indirection refactor) **[docs]**.
8. **Prompt injection via stored memories** accepted as residual risk; no content firewall on retrieved memory/RAG excerpts before injection **[docs]**.
9. **Checkpoints are unbounded per session** (pruned only on session delete) **[docs]**.

### 4.2 Table-stakes vs. coding-agent competitors **[research, cross-checked vs code]**
1. **Lifecycle hooks** (pre/post tool-call, session start/stop; user scripts) — Claude Code, Gemini CLI, Copilot have them; Relay has none (noted as "cheap because `check_permission()` is centralized" in the project's own Action_list).
2. **Triggers beyond cron** for automations — inbound webhooks as a *trigger* (Relay only posts outbound on completion), file-watch, git-event (push/PR), email/IMAP. n8n/Zapier/ChatGPT Scheduled all ship richer trigger sets.
3. **Declarative named subagents** — user-defined agents with their own prompt, tool allowlist, permission scope, model (Claude Code subagents, Copilot `.agent.md`, Roo orchestrator, Amp). Relay's `Task`/`spawn_session` are ad-hoc, not user-definable.
4. **Worktree-per-agent auto-provisioning** in orchestration — Cursor 2.0 isolates each of 8 parallel agents in worktrees; Relay supports worktrees but doesn't auto-provision one per spawned agent.
5. **Inline per-hunk edit review** — the default interaction model elsewhere (Cursor/Zed/Cline); Relay removed accept/reject per edit by design (harnesses run full-auto), leaving only per-turn Undo. A "confirm edits" middle posture is missing.
6. **Shareable session/trace links** (OpenCode share, Amp threads, Warp Drive) — no equivalent; would also serve bug reports.
7. **Autonomous PR review bot** (Bugbot/Copilot review) — Relay can technically build this from automations + GitHub tools, but there's no packaged experience.
8. **Cloud/remote execution ("cloud burst")** — every major vendor has an off-machine path; Relay is purely local (deliberate non-goal — needs a strategic decision, not necessarily a feature).
9. **Secret redaction in agent runs/snapshots** (Codex) — none in Relay.
10. **AGENTS.md native read/write** — de-facto repo standard (donated to AAIF); Relay's harness bundles exist but don't read/author `AGENTS.md`.

### 4.3 Standards & ecosystem drift **[research]**
1. **MCP client is 2025-generation.** Missing vs. the 2026-07-28 spec: stateless request model (`_meta` capabilities/identity), `server/discover`, MRTR (`input_required` → `inputResponses` loop), `subscriptions/listen`, Tasks extension (`tasks/get`/`tasks/update`), tool annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint` + icons) mapped to Relay's permission ladder, `ttlMs`/`cacheScope` caching, `Mcp-Method`/`Mcp-Name` routing headers, CIMD auth + `iss` validation in connectors. (Sampling/roots/logging are deprecated — don't invest.)
2. **MCP Apps host** (SEP-1865, first official extension) — sandboxed-iframe tool UIs; supported by Claude/ChatGPT/VS Code; Relay's rich desktop shell is a natural early host; also a differentiator.
3. **Official MCP registry integration** — Relay's gallery is a hand-curated list; the registry API + namespace-verification badges + one-click install are now standard.
4. **Agent Skills standard (SKILL.md)** — Relay reads/writes SKILL.md dirs but has no progressive-disclosure metadata layer, no skills gallery/marketplace, no install-from-URL (on the project's own roadmap), and no packaged distribution of Relay-native expertise as skills.
5. **A2A v1.0** — Session Mesh is internal-only; A2A Agent Card/task lifecycle would let Relay sessions interop with external agents (150+ orgs in production **[research]**).
6. **OTel GenAI observability** — no trace export (`gen_ai.*` spans, cached-token attributes, OTLP to Langfuse/Helicone); no `traceparent` propagation into MCP `_meta`; cost dashboard is spend-only, not trace-grade.
7. **Native provider search tools** — Anthropic/OpenAI server-side `web_search` tools (Responses API) unused; Relay's default search is keyless scraping.

### 4.4 Product/quality ceilings **[code, cross-checked]**
1. **RAG quality**: brute cosine over one embedding model, no hybrid fusion ranking (FTS leg exists but is unioned crudely), no reranker, no contextual chunk enrichment, no eval harness. This is the single biggest quality gap in the local stack.
2. **Local serving**: one chat model at a time; no continuous batching/concurrent slots; no live load-time VRAM estimator tied to sliders (market-time detection only); no per-model tool-calling capability badges or raw tool-call debug view.
3. **Voice**: turn-based pipeline only — no streaming partial transcripts, no sentence-level streaming TTS, no barge-in; no system-wide dictation (in-app only); no real-time/local speech-to-speech exploration.
4. **Web search**: scraping-based default; no native provider search; no YouTube transcript tool (yt-dlp) or Exa.
5. **Docs index**: not watcher-driven (manual re-index); image OCR Windows-only.
6. **GitHub surface**: PR-only — no issues, no merge, no repo CRUD, no PAT fallback path; GitHub is the only git host (GitLab on the roadmap).
7. **Multi-model comparison**: 6 panes exist, but no fork-two-models-on-one-thread compare view (Msty Split Chats / LM Studio Split View pattern).
8. **Chat export**: markdown + zip exist; no PDF export; memory/automations/improve tables excluded from backups (asymmetric export).
9. **Automations UX**: no approval-gate step inside a run, no chained/dependent automations, no per-run cost projection.
10. **Loops feature is effectively empty** — scanner returns nothing until a harness creates `loops/`; UI ships regardless.

### 4.5 Platform & parity **[code]**
1. **Windows-only shipping**: NSIS-only target; macOS .dmg compile-only (on roadmap as P3); Linux undecided (iframe browser fallback, XOR secrets, no OCR, no STT one-click install, no TTS GPU, no run-while-closed).
2. **Run-while-closed automations Windows-only** (launchd/cron deferred).
3. **Mobile companion**: no task dispatch from phone (competitors do phone→desktop task initiation **[research]**), no automations CRUD, no git/PR tools, no connector/memory/knowledge editing, no PDF/DOCX in-app preview, push needs a dev build (Expo Go can't push), stale push tokens never cleaned, `expo-secure-store` migration not done, pairing token in AsyncStorage.
4. **Harness approval parity**: only Claude Code gets live approval cards; Kimi/OpenCode/ACP runs are always full-auto with post-hoc diffs.
5. **Kimi cross-attribution risk** (two panes, same cwd, probe window) documented open **[code]**.
6. **Renderer-crash recovery** for browser panes unhandled; Linux pane drift between resize syncs **[docs]**.
7. **Quick-action keybindings stored but never registered OS-wide** (no `globalShortcut`); no Alt+Space-style global quick-capture.
8. **No i18n/localization layer**; RTL only via `dir=auto`; no a11y audit.

### 4.6 Engineering hygiene **[code/docs]**
1. **CI runs no tests** — `.github/workflows/build.yml` has no `cargo test`/`vitest`/`tsc` step; regressions can ship to release.
2. **`cargo clippy` not installed/wired**; ~1,733 `.unwrap()`s in non-test Rust as a breadth signal.
3. **Bundle bloat**: react-markdown/micromark (~450 KB) in entry chunk; `babel-standalone` (2.98 MB) + `flowchart-elk` (1.45 MB) not code-split; entry chunk regrown to ~766 KB.
4. **24 recurring frontend timers**, six 1 Hz whole-component ticks + always-on pet rAF.
5. **`AutomationRunTable` and CSV preview not virtualized**; `get_git_status` spawns git per call (no cache).
6. **Single global DB mutex** — fine now, flagged for observation at 100+ projects; vector search materializes every embedding blob per query.
7. **Stale hardcoded price table** + uniform 0.1× cache-read rate under-prices OpenAI cache hits ~5×.
8. **Dead/orphaned code**: `DocumentsLibrary.tsx` mounted nowhere; `ProjectItem`/`SessionRow` leftovers of the retired projects tree; `SHOW_FAKE_UPDATE` wired into shipping paths; static harness model catalog carries a live-query TODO.
9. **~40 `react-hooks/exhaustive-deps` suppressions** concentrated in the largest components; occlusion-registration tax on every new overlay.
10. **Docs staleness**: `BUILD_LOG.md` ends 2026-08-14; `docs/research/` point-in-time; several older audit docs overstate open work.
11. **Google Fonts fetched from network at cold start** in a local-first app; CSP allows cdnjs (deliberate but fragile).

---

## 5. Improvements to existing features (prioritized)

Effort: S < 1 day-ish · M ≈ 1–3 days · L ≈ 1–2 weeks · XL > 2 weeks (solo, rough).

| # | Improvement | Why now | Effort | Impact |
|---|---|---|---|---|
| 1 | Add `cargo test --lib`, `vitest`, `tsc --noEmit`, `cargo clippy -D warnings` to CI | Nothing prevents shipping regressions today | S | Critical |
| 2 | Sign installer (Azure Artifact Signing or OV cert) + submit winget manifest | Distribution trust; every competitor signed | M | Critical |
| 3 | Windows sandbox layer 1: Job Objects + write-restricted token for `run_code`/`run_shell` (Codex blueprint), graceful fallback banner | Unlocks honest `full_auto`; top safety gap | L–XL | Critical |
| 4 | Map MCP tool annotations (readOnly/destructive hints + icons) into the permission ladder and approval cards | Cheap correctness win; aligns with 2026 MCP | M | High |
| 5 | Hooks system (pre/post tool-call user scripts) via centralized `check_permission()` | Project's own Action_list says it's cheap; table stakes | M | High |
| 6 | Automation triggers beyond cron: inbound webhook listener, file-watch (reuse git watcher infra), git-event, email/IMAP | Closes the biggest automation gap | L | High |
| 7 | Hybrid RAG: RRF-fuse FTS5 + vectors, add local ONNX bge-reranker-v2-m3 (top-50→top-8), contextual chunk enrichment (path+headings) | Biggest local-quality ceiling; local-first friendly | L | High |
| 8 | Live load-time VRAM estimator (sliders → predicted memory, OOM warn) in the local-model load panel | LM Studio sets this bar; parts exist (auto-NGL, watts) | M | High |
| 9 | Per-model tool-calling badges + raw tool-call debug pane for local models | Trust in local agents | S–M | Medium |
| 10 | Streaming voice loop: partial whisper transcripts, sentence-level Kokoro streaming, barge-in cancel | Voice becomes "usable," not "demoable" | L | High |
| 11 | Auto-provision a worktree per spawned session/agent (opt-in toggle already exists per chat) | Matches Cursor/OpenCode orchestration norm | S–M | Medium |
| 12 | Register or remove quick-action keybindings; add global Alt+Space quick-capture overlay (answers via last provider) | Known dead setting; Raycast/Ollama/Gemini pattern | M | Medium |
| 13 | Replace static harness model catalog with live `list_harness_models` (TODO already in code) | Pricing drift; wrong models shown | S | Medium |
| 14 | Auto-refresh pricing table + family-aware cache-read rates; show cache savings in cost dashboard hero | Under-pricing ~5× for OpenAI cache | M | Medium |
| 15 | Budget enforcement mode (warn → pause-at-threshold) as opt-in; per-run live spend projection | Advisory-only today | M | High |
| 16 | Checkpoint pruning (count/age-based per session) | Unbounded refs growth | S | Medium |
| 17 | Backup/export completeness: include memory, automations, improve tables in project zip export | Asymmetric export today | M | Medium |
| 18 | Code-split `babel-standalone` + `flowchart-elk`; lazy-load react-markdown; virtualize AutomationRunTable | Entry chunk ~766 KB and growing | M | Medium |
| 19 | Fix Kimi two-pane session cross-attribution; add session-id source confidence indicator | Documented open bug | S–M | Medium |
| 20 | Delete/mount orphans: `DocumentsLibrary`, leftover ProjectItem/SessionRow, `SHOW_FAKE_UPDATE`, dead layout code | Hygiene | S | Low |
| 21 | Self-host Google Fonts (bundle woff2) | Local-first integrity; cold start | S | Low |
| 22 | Mobile: expo-secure-store migration + push-token cleanup + version sync | Documented skipped items | M | Medium |
| 23 | Linux decision: pick tier (supported/experimental/unsupported), then fix secrets (proper encryption), OCR fallback, browser drift | Endless half-state is worse than a decision | M + decision | Medium |
| 24 | Harness approval parity: extend approval-card relay to Kimi/OpenCode (they support permission flags) or document the gap in-UI | Silent full-auto surprise | L | Medium |
| 25 | Watcher-driven incremental docs indexing (reuse git-watcher infra); cross-platform OCR fallback path | RAG freshness on Windows + elsewhere | M | Medium |
| 26 | Mesh turn-end hooks + Settings section + eval scenarios (close Session Mesh P4) | P4 partial; polling latency | M | Medium |
| 27 | Improvements engine P3: cross-artifact pack health, flaky-case quarantine, artifact cost attribution in dashboard | Shipped P0–P2; P3 designed | M | Low |
| 28 | Browser: renderer-crash recovery affordance, `upload_file` (allowlist dir), downloads-to-workspace with timeline | Phase-3 differentiators already researched in-repo | L | Medium |
| 29 | Connectors: Slack/Linear/Jira additions + connector health dashboard (token expiry surfacing) | On roadmap; clear enterprise pull | M–L | Medium |
| 30 | Second git host: GitLab (REST + connector) | Reduces single-vendor risk | L | Medium |

---

## 6. New feature proposals (grouped, prioritized)

### Tier 1 — strategic, do next quarter
1. **Windows sandbox stack for agent execution** (S/J + restricted token + AppContainer + per-domain network proxy allowlist; Codex/MXC blueprint). *Impact: unlocks full_auto honestly, unattended automations, and enterprise credibility. Effort: XL, incremental (Job Objects first).* [research]
2. **MCP 2026 client upgrade pack**: stateless `_meta` request model + `server/discover`, MRTR input loop wired into the existing approval card UI, Tasks extension, CIMD OAuth in connectors, official registry in the gallery with verification badges. *Impact: keeps the app's core interop current; Relay already has strong MCP bones (client + gallery + 2 servers). Effort: L each, ship as a series.* [research]
3. **MCP Apps host** (SEP-1865): render tool-provided UIs in Relay's existing sandboxed-iframe + postMessage infrastructure (already battle-tested by JSX/HTML previews). *Impact: first-mover desktop host; makes connectors/MCP visually first-class. Effort: L.* [research]
4. **Hooks + triggers automation pack**: pre/post-tool hooks (5.5) + inbound webhook/file-watch/git/email triggers (5.6) + approval-gate step inside automation runs + chained automations. *Impact: turns automations from "cron for prompts" into a local n8n-class surface — a real differentiator when combined with run-while-closed. Effort: L–XL total.* [research]
5. **Declarative subagents ("Crew")**: user-defined named agents (prompt, tool allowlist, permission scope, model, worktree policy) stored in DB, spawnable via UI, `Task`, `spawn_session`, and automations; auto-provision worktrees. *Impact: converts Session Mesh + subagents into a product; matches the Claude Code `.md` subagent economy. Effort: L.* [research]
6. **Skills marketplace v1**: install-from-URL, SKILL.md progressive-disclosure loader, publish Relay-native skills (browser control, doc-gen, research), gallery with the MCP registry pattern (namespace verification). *Impact: rides the Agent Skills standard (Anthropic/OpenAI/Microsoft adopting); cheap distribution. Effort: M–L.* [research]
7. **Inline edit-review posture**: optional "confirm edits" mode that intercepts write/edit tools with per-hunk accept/reject cards (reuse DiffCard + checkpoint machinery) for users who don't want full-auto. *Impact: closes the biggest interaction-model gap vs Cursor/Cline without abandoning full-auto. Effort: L.* [research]
8. **OTel GenAI trace export + agent run timeline**: per-session/automation trace (spans per tool call with IO/diff previews), OTLP export toggle, `traceparent` into MCP `_meta`; timeline UI reusing the browser-timeline component. *Impact: observability is unserved in desktop shells; doubles as debugging + trust UX. Effort: L.* [research]

### Tier 2 — high-value differentiators
9. **Real-time voice mode**: streaming STT + streaming Kokoro + barge-in; later evaluate Moshi/Ultravox local speech-to-speech sidecar. *Effort: L–XL.* [research]
10. **System-wide dictation + quick capture**: global hotkey overlay (Alt+Space) that dictates/asks from any app using the existing whisper + provider stack; optional "type into focused window." *Effort: M–L.* [research]
11. **OpenAI-compatible local endpoint**: expose Relay's llama-server sidecars (and a stateful `previous_response_id` API) on loopback so ChatGPT/Claude Desktop/other tools can use Relay's models — free distribution, Ollama's playbook. *Effort: M.* [research]
12. **`relay daemon` headless mode + `relay chat` CLI**: run sidecars/automations/mesh without UI; enables home-server deployments and SSH use. *Effort: M–L (sidecar binaries already exist).* [research]
13. **Multi-model compare view**: fork a thread to 2–3 models side-by-side (panes exist), vote/merge the winner; auto-compact shared prefix for cost. *Effort: M–L.* [research]
14. **Auto model routing Phase 4**: OpenRouter `auto` as ranking source, learned router from thumbs-down/retry feedback, TTFB-aware ranking (telemetry already collected). *Effort: M.* [code: Phase 4 designed in-repo]
15. **Project wiki / repo knowledge**: auto-generate + maintain a searchable project knowledge base from git history + RAG (Devin Wiki pattern), surfaced as an agent tool and sidebar tab. *Effort: L.* [research]
16. **Packaged PR review bot**: automation template that reviews open PRs on schedule with the GitHub review tools + posts review comments (Bugbot pattern); include eval pack. *Effort: S–M (parts all exist).* [research]
17. **Phone → desktop task dispatch**: compose a task on mobile → runs as a desktop automation/session with push on completion (extends the pairing channel; Claude Cowork pattern). *Effort: M.* [research]
18. **AGENTS.md support**: read/layer project `AGENTS.md` into harness bundles + built-in chat context; author/update via tools. *Effort: S.* [research]
19. **A2A interop for Session Mesh**: Agent Card + task lifecycle so Relay can delegate to external A2A agents (and expose itself). *Effort: L.* [research]
20. **Local vision/audio chat UX**: unified GGUF + mmproj pairing in the market (partially exists), image-paste flow for local vision models, capability badges; later libmtmd audio/video input. *Effort: M.* [code+research]

### Tier 3 — broaden and polish
21. **macOS .dmg + Linux packages** with platform-tier decision (§5.23). *Effort: L + decision.* [code]
22. **RAG eval harness + goldens per corpus** (recall@k regression gates in CI). *Effort: M.* [code: research R14 analog]
23. **Research mode R12/R15/R16**: rolling `research_state` file + phase compaction; sources-disagree conflict cards; best-of-N "Heavy" runs; yt-dlp transcripts; Exa provider. *Effort: M each.* [code: designed in-repo]
24. **Diagram P2**: handDrawn look toggle; PDF export via pagedjs; `.mmd` regression corpus. *Effort: S.* [code]
25. **Memory upgrades**: sensitive-topic exclusions, episodic-tier decision from eval data, fully-local extraction path, multi-profile groundwork. *Effort: M–L.* [code]
26. **GitHub issues + PAT path; connector writes beyond Google's REST fallbacks.** *Effort: M.* [code]
27. **Share links** (static HTML export of a session trace, sanitized) or `.relaytrace` export for bug reports. *Effort: M.* [research]
28. **i18n layer + RTL audit + a11y pass.** *Effort: XL, incremental.* [code]
29. **Secret redaction** in logs/export/snapshots (regex + entropy scan before write). *Effort: M.* [research]
30. **Computer use (OS control)** — strategic watch item: Relay's browser panes cover the web; full OS control is where Claude Cowork/Codex are going. Decide whether to compete (browser-first + selective OS actions via connectors) or stay scoped. *Decision item.* [research]

### Explicit non-goals to re-confirm (PRD §2/§14, unchanged)
Cloud execution/VMs (see Tier-1 #4 for the local alternative), IDE/autocomplete, enterprise SSO/SCIM, free frontier-model access, web client. Each is a documented decision, not an oversight — revisit only if positioning changes.

---

## 7. Recommended sequencing

**Now (next 2–4 weeks) — trust + hygiene:**
CI tests + clippy (5.1) · installer signing + winget (5.2) · Windows sandbox layer 1: Job Objects (5.3) · MCP tool annotations → permissions (5.4) · hooks system (5.5) · keybindings register-or-remove + Alt+Space capture (5.12) · live harness model catalog (5.13) · checkpoint pruning (5.16) · orphan cleanup (5.20).

**Next (1–3 months) — ecosystem + quality:**
MCP 2026 client series (6.2) · MCP registry in gallery (6.2) · automation triggers pack (5.6) · hybrid RAG + reranker (5.7) · VRAM estimator (5.8) · declarative subagents + worktree-per-agent (6.5, 5.11) · confirm-edits posture (6.7) · skills install-from-URL + gallery (6.6) · streaming voice loop (5.10) · budget enforcement (5.15) · OTel traces (6.8).

**Later (3–6+ months) — reach + frontier:**
macOS/Linux + platform tier (6.21) · MCP Apps host (6.3) · real-time voice (6.9) · local OpenAI-compatible endpoint + daemon mode (6.11/6.12) · multi-model compare (6.13) · routing Phase 4 (6.14) · project wiki (6.15) · A2A (6.19) · mobile v2 (dispatch, automations CRUD, previews) (6.17) · GitLab + Slack/Linear/Jira connectors (5.29/5.30) · i18n (6.28) · computer-use decision (6.30).

---

## 8. Where Relay is already ahead (defend these)

1. Agent-controllable **native browser panes** + browser MCP server exposing the *real* visible panes — no coding-agent competitor embeds this.
2. **GGUF model market** with one-click local serving, VRAM fit, cost-at-$0 — unique supply chain.
3. **Session Mesh** peer-to-peer agent messaging/spawning — competitors have hierarchical subagents only.
4. **Run-while-closed local automations** (Task Scheduler sidecar) — all cloud competitors run schedules on their servers.
5. **Self-improving artifacts** loop (sweep → propose → eval → promote) — nothing comparable shipped elsewhere.
6. **Cross-agent cost dashboard** seeing every provider incl. local — competitors meter only their own credits.
7. **Cross-agent checkpoints/undo** normalized across six CLIs; per-turn Undo.
8. **Windows-first local-first posture** — macOS-first competitors (Codex desktop, Warp, Claude) leave the Windows-native agent shell lane open.
9. Full **voice stack** (whisper STT + Kokoro TTS + phone voice-memo transcription) in a coding shell.
10. **Document generation** (docx/pptx/xlsx/pdf with design systems + QA probes) inside an agent shell.

---

## 9. Sources & method

- Internal: full code maps of `src/`, `src-tauri/src/`, `mobile/` (this pass); `docs/ai-context/*`, `docs/audits/*`, `docs/architecture/*`, `docs/research/*`, `CHANGELOG.md`, `CODEBASE_AUDIT_2026-09-17.md`, `CODEBASE_AUDIT_FULL_2026-09-14.md`.
- External (Sept 2026 web research): Claude Code docs/changelog; OpenAI Codex app/sandbox posts; Cursor changelog; Cognition/Devin + Windsurf docs; Zed/ACP; Warp; Goose; Gemini CLI/Antigravity; Amp; OpenCode/Crush; Cline/Roo/Continue; GitHub Copilot Agent HQ; LM Studio 0.4 blog; Ollama blog/docs; llama.cpp multimodal docs; Open WebUI releases; AnythingLLM; Cherry Studio; Msty; Raycast; Wispr Flow/superwhisper; MCP spec changelogs 2025-11-25 & 2026-07-28 + MCP Apps post + registry; agentskills.io; A2A/Linux Foundation; OpenTelemetry GenAI semconv; OpenAI "Building Codex Windows sandbox"; Microsoft MXC; Azure Artifact Signing docs; LanceDB/sqlite-vec/Pinecone reranking guides.
- Items marked **[research]** came from secondary sources; re-verify against primary docs before implementation. Known-uncertain items are flagged inline in the research annexes (notably: Codex Goal Mode date, Antigravity pricing tie-in, sqlite "Vec1" extension, Artifact Signing regional availability).
