# Relay — Full Feature Map & Gap Analysis (2026-09-19)

> Point-in-time analysis of the entire product: every feature mapped from the code, cross-checked
> against existing audits (`docs/audits/`, `CODEBASE_AUDIT_*`), and against the September 2026
> competitive landscape (coding agents, AI chat/local-LLM desktop apps) and agent-ecosystem
> standards (MCP, A2A, Agent Skills, OTel). Items marked **[code]** were verified in the codebase;
> items marked **[research]** come from external research and should be re-verified before building.
>
> **Re-verified 2026-09-30 against the codebase** (73 commits landed since this analysis). Claims
> that no longer hold are marked inline: ✅ = resolved (with the commit/date that closed it),
> 🟡 = partially resolved (what remains is stated). Unmarked claims are still open. Section 2's
> snapshot numbers were refreshed in the same pass; §4.1.6 and the babel/elk half of §4.6.3 were
> found to be stale *when written* (already true/false before 2026-09-19).
>
> **Second pass, also 2026-09-30:** six open gaps were implemented end-to-end in one wave —
> RAG contextual enrichment (§4.4.1), per-model tool-calling badges + the raw tool-call debug
> pane on the Logs page (§4.4.2), harness approval parity (§4.5.4), Session Mesh P4 (§5.26),
> improvements-engine P3 (§5.27), and the browser trio (§5.28). All ✅ marks below reflect the
> post-wave state; the full suites (cargo test/clippy, vitest, tsc) gate every claim.
>
> **Fourth pass, also 2026-10-01 (second wave, same day):** twelve more gaps
> implemented end-to-end — the exec-gate approval seal (§4.1.4), checkpoint
> pruning (§5.16), MCP tool annotations → permission ladder (§5.4), GitHub
> issues + PAT fallback (§4.4.6), packaged Relay-native loops (§4.4.10),
> OpenAI native server-side search (§4.3.7 second half), the skills gallery +
> packaged Relay-native loop expertise (§4.3.4 remaining halves), the docs
> filesystem watcher (§5.25 first half), CSV preview virtualization (§4.6.5),
> self-hosted Google Fonts (§5.21), mobile expo-secure-store migration +
> push-token cleanup + pairing-token migration (§5.22, §4.5.3), and the
> distribution trust scaffolding (§5.2 partial: winget/Scoop manifests +
> Authenticode signing CI). Live checks in this wave: the full 12-entry
> skills catalog verified against the real GitHub contents API, a live
> anonymous issues listing against api.github.com, and the exec-gate seal
> exercised against the real OS keychain (including key-loss fail-closed).
> Gates: `cargo test --lib` 1,568 passed (20 ignored), `cargo clippy -D
> warnings` clean, vitest 213 files / 1,666 tests passed, `tsc --noEmit`
> clean (app + mobile), and `vite build` verified (font bundling + CSP JSON).
> An audit pass the same day then fixed three defects found in this wave's
> own work: the restore-safety checkpoint no longer triggers the over-cap
> prune (which could delete the checkpoint being restored to), the CSV
> virtualizer's tail spacer mixed pixel offsets with row counts (scrollbar
> corruption mid-scroll), and `fonts.css` used JS-style comments that broke
> `vite build` — all covered by regression tests or a green build.
>
> **Third pass, 2026-10-01:** eight more gaps implemented end-to-end with live testing —
> challenge-response pairing (§4.1.5), the prompt-injection content firewall (§4.1.8), the
> confirm-edits posture (§4.2.5), packaged automation templates incl. the PR review bot
> (§4.2.7), AGENTS.md read/layer/author (§4.2.10), MCP registry search + one-click install
> (§4.3.3), skills install-from-URL + the frontmatter metadata layer (§4.3.4), and Anthropic's
> native server-side web_search (§4.3.7). Live checks that hit real endpoints: the MCP registry
> API (registry.modelcontextprotocol.io), a full GitHub skill-tree install from
> anthropics/skills, and loopback WebSocket/HTTP fixtures for the pairing handshake and the
> skill installer. Gates at the end of the wave: `cargo test --lib` 1,550 passed (18 ignored),
> `cargo clippy -D warnings` clean, vitest 212 files / 1,663 tests passed, `tsc --noEmit`
> clean (app + mobile).

---

## 1. Executive summary

Relay is in an unusually strong and clean state: four audit waves fully remediated, no open Sev-1
bugs, ~339 backend commands across 16 subsystems, a 17-section settings surface, 200 frontend test
files (~1,567 tests as of 2026-09-30), and several features **no competitor ships** (agent-controllable native browser panes, a
GGUF model market with one-click local serving, Session Mesh peer-to-peer agent messaging,
run-while-closed local automations, self-improving artifacts, a cross-agent cost dashboard).

The gaps cluster into six themes, in rough priority order:

1. **Trust & safety** — model-authored code runs with full user privileges (no OS sandbox); the
   installer is unsigned; budgets are advisory-only. This is the single biggest blocker to
   honestly selling `full_auto` and to distribution growth.
2. **Ecosystem drift** — MCP moved to a stateless 2026-07-28 spec with MCP Apps, a registry, and
   tool annotations; Agent Skills (SKILL.md) became an open standard; A2A hit v1.0. Relay is a
   2025-generation MCP client and has partial skills support.
3. **Table-stakes parity** — hooks (pre/post tool events) ✅, triggers beyond cron ✅, declarative
   named subagents ✅, shareable trace/session links, cloud-burst execution (currently a deliberate
   non-goal), inline per-hunk edit review ✅ (the confirm-edits posture, 2026-10-01).
4. **Quality ceilings** — RAG is brute cosine with no reranking/hybrid fusion ✅ (RRF + reranker +
   contextual enrichment all shipped); web search is scraping-based; one local model served at a
   time; no local vision/audio input path in chat UX.
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
| Test surface | 213 vitest files (1,666 tests), `cargo test --lib` 1,568 passed (20 ignored), clippy `-D warnings` clean, `tsc --noEmit` clean (2026-10-01 fourth pass; was 212/1,663/1,550 earlier the same day). CI gates every push: `tsc` + `vitest` + `cargo test` + `clippy -D warnings` (`.github/workflows/ci.yml`) |
| Backend surface | ~339 registered Tauri commands, 30+ ALTER-style DB migrations |
| Agent tools exposed to models | 46+ built-in tools (see §3.13) plus vendor MCP/connector tools |

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
- **Agent control**: click/type/scroll/hover by ref, fill_form, select_option, press_key, snapshot/read_page (cleaned Markdown + ref map), observe, extract, evaluate JS, wait_for, tab management, batch ops, screenshot, console/network reads, cookie-banner dismissal, `upload_file` (workspace-allowlisted file onto a page's file input via the DevTools protocol; 2026-09-30).
- **Trust layer**: URL gates, pause/stop, credential-takeover confirmations, user-owned action timeline, agent-active indicator, watch mode pacing.
- **`relay-browser-mcp` sidecar**: standalone stdio MCP server + CLI exposing the real visible panes to any harness via loopback WS (29 operations — `upload_file` added 2026-09-30); per-project `.mcp.json`/config registration at spawn.

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
Read-only: `web_search, fetch_url, open_url, browser_read, browser_screenshot, browser_observe, browser_extract, browser_upload_file (cap, workspace-allowlisted), generate_file, generate_document, plan_document, revise_document, generate_diagram, generate_image, get_skill, list_skills, list_artifacts, get_capabilities, attach_connector, attach_mcp_server, add_source_note, get_source_ledger, reset_source_ledger, check_sufficiency, todo_write, enter_plan_mode, present_plan, list_directory, read_file, search_files, search_content, search_docs, totp_code, list_automations, list_sessions, read_session, search_sessions, Task, get_task_status, cancel_task, browser_click/type/scroll (cap)`.
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
4. ✅ **Exec-gate remembered approvals live in plain `app_settings`** — closed 2026-10-01 (fourth pass): the remembered decision is now an HMAC-SHA256 tag over kind+ident, keyed by a random 32-byte key in the OS keychain (`secrets::platform_store`, namespace `execgate`) — `exec_gate.rs::seal_value`/`is_allowed`. A DB writer can no longer pre-allow execution: a plain legacy `"1"`, a forged value, or a seal under a different keychain key (restored DB on a new machine) all read as NOT allowed and re-ask. `exec_gate::migrate_legacy` runs at boot and drops unverifiable rows; if the keychain is unavailable, remembering degrades to "ask every time" (nothing plain is ever written). Tests exercise the real keychain including key-loss fail-closed and the no-resurrection migration.
5. ✅ **Pairing proof is replayable** — closed 2026-10-01 with a challenge-response handshake: the desktop now opens every connection with a fresh 32-byte `PairChallenge` frame, and challenge-capable phones (a `v2: true` flag on `Pair`) prove possession with `HMAC(token, "E2E-NONCE-V1" || nonce)` (`relay_crypto.rs::compute_pair_proof_with_nonce`) — bound to THAT connection, so a captured Pair frame fails on any other connection (live loopback test: `captured_pair_frame_cannot_be_replayed_on_a_new_connection`). A 5-failure/60s pairing lockout backs it (`PairAttemptTracker`). Old phones keep the legacy static-proof path for compatibility, and `mobile.pairing.require_challenge` (Settings → Remote → "Strict pairing") refuses it once the fleet is v2. The HKDF/proof cross-implementation vector is pinned against @noble on both sides.
6. ✅ **Linux secrets are XOR-obfuscated, not encrypted** — stale when written: Linux has used the OS keyring (Secret Service via D-Bus, `keyring = "3"` with `linux-native` features) since 2026-07-31 (`secrets.rs:15-18`); XOR remains only as the no-keyring-backend fallback (`secrets.rs:262-284`).
7. **Harness bearer tokens sit in plaintext project `mcp.json`/`opencode.json`** (CLI-required; needs env-var indirection refactor) **[docs]**.
8. ✅ **Prompt injection via stored memories** — closed 2026-10-01 with a deterministic content firewall (`prompt_firewall.rs`): every retrieved block — the memory injection block (built-in chat + harness bundles), `memory_recall` hits, `search_docs` results, and the auto-retrieval "Retrieved context" message — passes a scanner for instruction-override/role-forgery/exfil patterns (with zero-width-character de-smuggling) right before injection. Modes via `security.prompt_firewall` (Settings → Memory → Content firewall): `flag` (default — fence the block with an untrusted-data header), `strip` (also redact the matched phrases), `off`. Deliberately deterministic and layered as a last line on top of the existing "treat as user data" framing — it is not a full prompt-shield.
9. **Checkpoints are unbounded per session** (pruned only on session delete) **[docs]**.

### 4.2 Table-stakes vs. coding-agent competitors **[research, cross-checked vs code]**
1. ✅ **Lifecycle hooks** — shipped 2026-09-21 (7ff4df6): user-configured scripts around agent tool calls with `pre_tool_use` (deny / ask / rewrite `updatedInput`), `post_tool_use`, and `TurnComplete`/`session_start` lifecycle events, configured in Settings → Hooks with Claude Code import (`src-tauri/src/hooks.rs`, ~1,700 lines); origin-scoped to chat/subagent/harness (76cbfbc). Only a `session stop` event is still absent.
2. ✅ **Triggers beyond cron** — shipped 2026-09-26 (2150eb5): inbound webhook listener (loopback server, per-automation secret, test button), file-watch (notify), git-event (HEAD-SHA compare), and Gmail (historyId) trigger engines alongside cron (`automation_triggers.rs:56-61`). Caveat: webhook/file/gmail triggers fire only while the app is open; run-while-closed scheduling is still Windows Task Scheduler cron only (§4.5.2).
3. ✅ **Declarative named subagents** — shipped 2026-09-24/26 (76cbfbc "declarative subagents — registry, five spawn surfaces, scoped hooks, .md interchange"; 7f0c510 CRUD chat tools with carded consent; d5d0235 harness-authored definitions read-only by default; f61bb58 "crew" → subagents). User-defined agents with prompt, tool allowlist, permission scope, model, and worktree policy, spawnable from UI/`Task`/`spawn_session`/automations, importable/exported as `.md`.
4. ✅ **Worktree-per-agent auto-provisioning** — shipped with declarative subagents (76cbfbc): each definition carries `worktree_policy: inherit | always | never` (`chat/subagents.rs:559-566`) and the spawn path provisions `relay/<slug>-<id8>` worktrees (`session_fabric/mod.rs:2217-2249`). Opt-in per subagent definition (default `inherit`), not a global per-session default.
5. ✅ **Inline per-hunk edit review** — shipped 2026-10-01 as the `confirm_edits` approval posture (between Manual Approval and Auto-Edit in the composer menu): writes/edits pause with a review card carrying a structured preview computed from the REAL file — `edit_file` lists every occurrence of the find text (1-based, with line numbers and context), `write_file` shows overwrite-vs-create plus a bounded content preview. The user accepts ALL, a SUBSET (per-occurrence checkboxes → partial apply: `fs_edit_file_selected` rewrites only the accepted occurrences and tells the model what was left untouched and not to re-edit it), or rejects. Delete/move/copy/shell gate exactly like manual. Backend: `ApprovalPolicy::ConfirmEdits` (`permission.rs`), preview builder + per-session selection parking in `dispatch.rs`/`chat/mod.rs`, `resolve_tool_action(selected)`. Per-turn Undo unaffected.
6. **Shareable session/trace links** (OpenCode share, Amp threads, Warp Drive) — no equivalent; would also serve bug reports.
7. ✅ **Autonomous PR review bot** (Bugbot/Copilot review) — packaged 2026-10-01 as built-in automation templates (`automation_templates.rs`): "PR review bot" (weekday cron, idempotent via a `[relay-review]` marker comment, gh-CLI based, never pushes/merges, fails fast unattended) and "Repo morning digest". Surfaced as one-click prefills in the Automations empty state + a Templates toggle in the header (and a "Review bot" button in the Pull Requests panel toolbar); creation goes through the same validated `create_automation` path — templates prefill, they do not bypass the form.
8. **Cloud/remote execution ("cloud burst")** — every major vendor has an off-machine path; Relay is purely local (deliberate non-goal — needs a strategic decision, not necessarily a feature).
9. **Secret redaction in agent runs/snapshots** (Codex) — none in Relay.
10. ✅ **AGENTS.md native read/write** — shipped 2026-10-01 (`agents_md.rs`): the bound project's AGENTS.md is LAYERED into both prompt surfaces — harness bundle instructions (CLI agents that don't discover the file natively still get it; capped at 8k chars to protect prompt caches) and the built-in chat's system prompt — with the standard's ancestor-walk discovery. Two registry tools author it: `read_agents_md` (read-only, discovery included) and `write_agents_md` (mutating — same permission ladder as write_file; create/overwrite/append, accepting a directory or a file path).

### 4.3 Standards & ecosystem drift **[research]**
1. **MCP client is 2025-generation.** Missing vs. the 2026-07-28 spec: stateless request model (`_meta` capabilities/identity), `server/discover`, MRTR (`input_required` → `inputResponses` loop), `subscriptions/listen`, Tasks extension (`tasks/get`/`tasks/update`), tool annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint` + icons) mapped to Relay's permission ladder, `ttlMs`/`cacheScope` caching, `Mcp-Method`/`Mcp-Name` routing headers, CIMD auth + `iss` validation in connectors. (Sampling/roots/logging are deprecated — don't invest.)
2. **MCP Apps host** (SEP-1865, first official extension) — sandboxed-iframe tool UIs; supported by Claude/ChatGPT/VS Code; Relay's rich desktop shell is a natural early host; also a differentiator.
3. 🟡 **Official MCP registry integration** — the registry half landed 2026-10-01: `mcp_registry_search` queries registry.modelcontextprotocol.io (live-verified), results render with a status badge (active + isLatest → "registry ✓"), env keys prefill from the entry's package metadata, and one-click install maps the first stdio package onto the same `McpServerDef` shape (allowlisted runtimes only: npx/bunx/deno/uvx/docker; version-pinned identifier; `from_gallery: false` so the exec gate still confirms the first spawn — the registry is open content). **Still open:** the rest of the §6.2 MCP 2026 client series (stateless `_meta`, MRTR, Tasks, tool annotations into the permission ladder — see §5.4), and namespace verification beyond the registry's own status field.
4. ✅ **Agent Skills standard (SKILL.md)** — all four halves closed 2026-10-01: install-from-URL (raw SKILL.md, GitHub blob, GitHub tree via the contents API, .zip with sibling files preserved; zip-slip and size guards; dual-root write) and the frontmatter metadata layer (`version:`, `allowed-tools:`) landed in the third pass; the fourth pass added the **gallery** (`skills_gallery.rs` + a Gallery tab in the Skills Library: a curated 12-entry bundled catalog, each entry live-verified against the GitHub contents API with an "unavailable" badge when it stops resolving — install goes through the SAME validated `install_skill_from_url`, no second write path) and **packaged Relay-native expertise** (`skills/loops/*.md`: repo-hygiene, docs-refresh, deps-audit — materialized once per machine into `~/.agents/loops` by `installed_skills::materialize_bundled_loops` under a tombstone, so user edits and deletions stick).
5. **A2A v1.0** — Session Mesh is internal-only; A2A Agent Card/task lifecycle would let Relay sessions interop with external agents (150+ orgs in production **[research]**).
6. **OTel GenAI observability** — no trace export (`gen_ai.*` spans, cached-token attributes, OTLP to Langfuse/Helicone); no `traceparent` propagation into MCP `_meta`; cost dashboard is spend-only, not trace-grade.
7. ✅ **Native provider search tools** — the Anthropic half shipped 2026-10-01 (third pass: opt-in `chat.websearch.native_anthropic` swaps the client tool for the server-side `web_search_20250305` block; the stream parser echoes `server_tool_use`/`web_search_tool_result` verbatim; server searches count as live-web for the tripwire). The OpenAI half closed in the fourth pass: opt-in `chat.websearch.native_openai` (Settings → Web Search) drops the client web_search tool from the OpenAI spec (`ToolCaps.native_search_openai`) and injects `web_search_options` into the Chat Completions request body (`ChatRequest.web_search_options` → `build_openai_body`), gated to NATIVE OpenAI only — compatible endpoints and OpenRouter never receive the parameter — and documented as search-preview-model-only, since plain models 400 on the unknown parameter. The keyless scraping default remains for everyone else, unchanged.

### 4.4 Product/quality ceilings **[code, cross-checked]**
1. ✅ **RAG quality** — closed in two waves: 2026-09-21 (5cb6c66) shipped RRF fusion + the reranker sidecar + the recall@8 eval harness; 2026-09-30 closed the last half — **contextual chunk enrichment**: the embedder input is now `path · heading + content` (`chat/docs.rs::enriched_embed_text`), `DOCS_CHUNK_SCHEMA_VERSION` bumped to 2 so every corpus re-chunks once, the reranker judges the same enriched documents, and the eval gained a dedicated enrichment case (context tokens reach the vector leg while FTS/display stay raw).
2. 🟡 **Local serving** — the debug half landed 2026-09-27 (9e66ed4); the badges half landed 2026-09-30: per-model **tool-calling capability badges** ("template" = chat template renders tool calls, "likely" = capable arch, "forced"/"disabled" = user override) in the model picker and Local Models panel, a tri-state Tool-calling override in the per-model gear menu, and the raw **tool-call debug pane** on the Logs page (`LogDetail.tsx` re-derives advertised tools + emitted calls — native `tool_calls` and Hermes text — from the stored verbatim bodies). An explicit "disabled" override also skips the tools schema on local turns instead of 400ing. **Still open:** live load-time VRAM estimator tied to sliders.
3. 🟡 **Voice** — streaming halves landed 2026-09-26 (398e5fd wave): whisper live partial transcripts (`speech.rs` partial/commit tags) and sentence-level Kokoro streaming (playback starts on the first sentence, `tts.rs:17-18`). **Still open:** barge-in cancel, system-wide dictation, speech-to-speech.
4. 🟡 **Web search**: scraping-based default; native provider search now exists for Anthropic (opt-in server-side web_search, §4.3.7); still no YouTube transcript tool (yt-dlp) or Exa, and no OpenAI Responses search.
5. 🟡 **Docs index**: the watcher half closed 2026-10-01 (fourth pass, §5.25) — `docs_watcher.rs` installs one notify watcher per enabled corpus root (git-watcher shape, 2 s debounce / 15 s burst cap); a change re-runs the incremental mtime/size-diff index via the same `spawn_index_job` the Index button uses, skipping when a job is in flight. Watchers install on boot, corpus add, and enable. **Still open:** cross-platform OCR fallback (image surrogates remain Windows.Media.Ocr on Windows; filename fallback elsewhere).
6. 🟡 **GitHub surface**: the issues half + PAT fallback closed 2026-10-01 (fourth pass, §4.4.6): `github_list_issues` / `github_get_issue` / `github_create_issue` / `github_add_issue_comment` / `github_set_issue_state` / `github_list_issue_comments` (PRs filtered from the issues list), an Issues surface in the Pull Requests panel (list → detail with comments, comment box, close/reopen, new-issue form), and a Personal Access Token fallback in Settings → Version control → GitHub authentication — `resolve_github_token` tries the OAuth connector first, then the keychain PAT (`github_set_pat`/`github_has_pat`/`github_clear_pat`), covering EVERY panel command at the shared `resolve_repo` choke point. Live-tested with an anonymous issues listing against api.github.com (`#[ignore]` test). **Still open:** merge, repo CRUD, GitHub being the only git host (GitLab on the roadmap).
7. ✅ **Multi-model comparison** — shipped 2026-09-22 (5801806): fork one chat into 2–4 new sessions pinned side-by-side (`ForkChatModal.tsx` `FORK_OPTIONS = [2,3,4]`, per-fork config + history copy + worktree, equalized pane ratios), each pane independently re-modelable — the Msty/LM Studio compare pattern (ratios fixed in fd51b05).
8. **Chat export**: markdown + zip exist; no PDF export; memory/automations/improve tables excluded from backups (asymmetric export).
9. **Automations UX**: no approval-gate step inside a run, no chained/dependent automations, no per-run cost projection. (The *trigger* half of this theme is solved — see §4.2.2.)
10. ✅ **Loops feature is effectively empty** — closed 2026-10-01 (fourth pass): Relay now packages three native loop definitions (`skills/loops/repo-hygiene.md`, `docs-refresh.md`, `deps-audit.md`, each speaking the `LOOP_STATUS` protocol so they work under `/goal` and automations), materialized once per machine into `~/.agents/loops/<slug>/LOOP.md` by `installed_skills::materialize_bundled_loops` (tombstone setting; existing user content always wins; deleted stays deleted). The Loops tab is populated on first run and every entry is an ordinary editable file.

### 4.5 Platform & parity **[code]**
1. **Windows-only shipping**: NSIS-only target; macOS .dmg compile-only (on roadmap as P3); Linux undecided (iframe browser fallback, XOR secrets, no OCR, no STT one-click install, no TTS GPU, no run-while-closed).
2. **Run-while-closed automations Windows-only** (launchd/cron deferred).
3. 🟡 **Mobile companion** — largely closed by the 2026-09-26 overhaul (398e5fd): ✅ task dispatch from phone (phone composer → desktop session, `mobile/dispatch.rs`), ✅ automations CRUD (create/edit/delete), ✅ memory editing (edit/forget/purge), 🟡 git tools (status/diff/commit/push/branches/log — no PR creation yet). **Still open (narrowed 2026-10-01 fourth pass):** connector/knowledge editing, PDF/DOCX in-app preview (save/share card only), push still needs a dev build (Expo Go ships without expo-notifications), PR creation from the phone. The pairing token now lives in the OS keychain (`mobile/src/lib/secureStore.ts`, one-way AsyncStorage migration; legacy keys remain a fallback read chain), and stale desktop-side push tokens are cleaned — Expo `DeviceNotRegistered` responses prune the stored token (`mobile/push.rs::clear_push_token`) and tokens older than 90 days without re-registration are dropped on read.
4. 🟡 **Harness approval parity** — much closer since 2026-09-26, and closed further on 2026-09-30: every adapter now carries `diff_prompt_patterns` (pane promotes to `diff_ready` on an approval prompt), `PermissionModeMenu` shows each CLI's OWN native postures — Claude Code default/acceptEdits/plan/bypassPermissions, Kimi manual/yolo/auto/plan, OpenCode build/plan, OMP always-ask/write/yolo, CommandCode standard/plan/accept-edits/yolo/dont-ask (all verified against the CLIs' 2026-09 docs) — and adapters map the picked label to real spawn flags (`permission_flags`), applied at pane start and headless where the CLI accepts them (CommandCode's `--permission-mode` replaces the formerly unconditional baked `--yolo`; "standard" headless now really blocks mutating tools). Harnesses with NO native per-call model (pi — project trust only; ACP v1 — no permission channel) render an explicit "in-pane approvals" note chip in the composer instead of a silently missing menu, and the menu hint states the residual gap plainly. **Still open:** Relay's interactive approval *cards* remain built-in-chat-only (documented in-UI now, not silent).
5. ✅ **Kimi cross-attribution risk** — fixed 2026-09-30: a process-wide claim registry makes the on-disk probe skip session ids another live pane already owns (stepping to the next candidate, flagged ambiguous), the recency guard is now mandatory, and Windows cwd matching is case-insensitive (`harness_adapters/mod.rs` `session_claims`, `kimi_code.rs` `find_newest_session_id`); provenance (`output` / `disk_probe` / `disk_probe_ambiguous`) is persisted on `sessions.harness_session_id_source` and surfaced as an `id?` badge in the pane header.
6. 🟡 **Renderer-crash recovery** — the Windows half closed 2026-09-30: WebView2 `ProcessFailed` → `browser:crashed` → the pane shows a crash card with a **Recover** button that re-creates the webview at the same URL, and the event lands in the trust timeline. **Still open:** Linux pane drift between resize syncs (and a macOS equivalent — WKWebView surfaces no such event through the tauri-managed child).
7. **Quick-action keybindings stored but never registered OS-wide** (no `globalShortcut`); no Alt+Space-style global quick-capture.
8. **No i18n/localization layer**; RTL only via `dir=auto`; no a11y audit.

### 4.6 Engineering hygiene **[code/docs]**
1. ✅ **CI runs no tests** — fixed 2026-09-19 (42dad6f): `.github/workflows/ci.yml` gates every push with `tsc --noEmit`, `vitest`, `cargo test --lib`.
2. ✅ **`cargo clippy` not wired** — fixed in the same commit: `cargo clippy --workspace --all-targets -- -D warnings` in CI; the pre-existing lint debt (766 instances) is allow-listed at the crate root and new lint kinds still fail.
3. ✅ **Bundle bloat** — the babel-standalone/flowchart-elk half of this claim was already stale when written (both were dynamic imports behind their own chunks since the 2026-09-06 manualChunks rework). The react-markdown half was real and is fixed 2026-09-30: parser + remark/rehype plugins (incl. KaTeX) now load behind `React.lazy` (`components/common/LazyMarkdown.tsx`), taking the entry chunk from 1,182 KB to 751 KB (gzip 364→234 KB) with zero markdown modules left in it. **Still open (moved):** CSV preview virtualization (§4.6.5).
4. 🟡 **Recurring frontend timers** — marginally improved: 23 `setInterval`s (was ~24) and **5** whole-component 1 Hz ticks (was 6) + the always-on pet rAF. Not addressed as an initiative.
5. 🟡 **Virtualization / git-status caching** — `AutomationRunTable` virtualized 2026-09-30 (`@tanstack/react-virtual`, rows windowed, verified with a 500-run test); the chat pane drop now auto-fits the axis instead of refusing (same date). **Still open:** `get_git_status` still spawns git per call (polling approach is deliberate per PRD §7.11). The CSV half closed 2026-10-01: `ArtifactPreviewPane`'s CsvTable windows its body rows through `@tanstack/react-virtual` above 200 rows (same shape as AutomationRunTable: estimate 32 px, overscan 12, jsdom-seeded initialRect), with top/bottom spacer rows keeping the scrollbar honest; small tables render fully. Verified by `csvTableVirtualization.test.tsx` (20-row CSV renders all; 2000-row CSV mounts < 1000).
6. **Single global DB mutex** — fine now, flagged for observation at 100+ projects; vector search materializes every embedding blob per query.
7. ✅ **Stale hardcoded price table + uniform 0.1× cache-read rate** — fixed 2026-09-26 (425e322): prices auto-refresh from the LiteLLM registry (~60 s after boot, then daily, `pricing_live.rs:218-223`), explicit per-model cache-read rates override the family default (OpenAI now prices its published 0.5×), an observed-rate layer feeds back from real usage (`db/cost_v2.rs`), and the cost hero shows cache savings.
8. ✅ **Dead/orphaned code** — cleaned 2026-09-30: `DocumentsLibrary.tsx`, `ProjectItem.tsx`/`SessionRow.tsx` (+ their test and orphaned CSS), `SHOW_FAKE_UPDATE` + `seedFakeUpdate`, `ensureBrowserTabs`, dead `.split-*`/`.broadcast-bar` layout CSS all deleted; the static harness model catalog TODO was resolved earlier by the live `list_harness_models` probe (425e322, §5.13).
9. 🟡 **`react-hooks/exhaustive-deps` suppressions** — 38 today (was ~40); occlusion-registration tax unchanged. Not addressed as an initiative.
10. 🟡 **Docs staleness** — `BUILD_LOG.md` gained a "Current status (verified 2026-09-21)" header (test counts, 369 commands) deferring newer history to git/AI_CONTEXT, but its dated entries still end 2026-08-14.
11. **Google Fonts fetched from network at cold start** in a local-first app; CSP allows cdnjs (deliberate but fragile).

---

## 5. Improvements to existing features (prioritized)

Effort: S < 1 day-ish · M ≈ 1–3 days · L ≈ 1–2 weeks · XL > 2 weeks (solo, rough).
Status re-verified against the code on **2026-09-30**: ✅ done · 🟡 partial · ⬜ open.

| # | Improvement | Why now | Effort | Impact | Status 2026-09-30 |
|---|---|---|---|---|---|
| 1 | Add `cargo test --lib`, `vitest`, `tsc --noEmit`, `cargo clippy -D warnings` to CI | Nothing prevents shipping regressions today | S | Critical | ✅ 42dad6f — `ci.yml` gates every push with all four |
| 2 | Sign installer (Azure Artifact Signing or OV cert) + submit winget manifest | Distribution trust; every competitor signed | M | Critical | 🟡 2026-10-01 — Authenticode signing wired into `build.yml` via the official `Azure/trusted-signing-action` (gated on five new secrets; a detect step keeps releases green with a notice when they're absent) + `packaging/winget/` three-file manifest set and `packaging/scoop/relay.json` with submission READMEs. **Remaining are external actions:** acquire the Trusted Signing certificate profile, set the secrets, submit the winget PR. Updater minisign unchanged |
| 3 | Windows sandbox layer 1: Job Objects + write-restricted token for `run_code`/`run_shell` (Codex blueprint), graceful fallback banner | Unlocks honest `full_auto`; top safety gap | L–XL | Critical | ⬜ — `codeexec.rs` TODOs intact; only kill-on-close Job Objects (orphan cleanup) exist |
| 4 | Map MCP tool annotations (readOnly/destructive hints + icons) into the permission ladder and approval cards | Cheap correctness win; aligns with 2026 MCP | M | High | ✅ 2026-10-01 — both MCP client paths (`mcp_gallery::GallerySession::tool_entries` + `connectors::mcp::RemoteTool`/`session.rs`) now read `annotations` from tools/list into the neutral `ToolHints {read_only, destructive}` (`chat/permission.rs::ToolHints`, rmcp-typed at the wire) and classify via `classify_connector_tool_annotated`: `readOnlyHint=true` → Read (keyword over-gating like "get_or_create" ends), `destructiveHint=true` or `readOnlyHint=false` → Write (server's explicit claim beats keywords; contradictory → Read wins per spec), missing hints → keyword fallback. Serde round-trip test pins the raw JSON shape. Icons not modeled (idempotent/open_world are informational) |
| 5 | Hooks system (pre/post tool-call user scripts) via centralized `check_permission()` | Project's own Action_list says it's cheap; table stakes | M | High | ✅ 7ff4df6 — pre/post tool-use (deny/ask/rewrite) + lifecycle events, Settings → Hooks, Claude Code import |
| 6 | Automation triggers beyond cron: inbound webhook listener, file-watch (reuse git watcher infra), git-event, email/IMAP | Closes the biggest automation gap | L | High | 🟡 2150eb5 — webhook listener, file-watch, git-event, Gmail shipped; webhook/file/gmail fire only while the app is open; IMAP not started |
| 7 | Hybrid RAG: RRF-fuse FTS5 + vectors, add local ONNX bge-reranker-v2-m3 (top-50→top-8), contextual chunk enrichment (path+headings) | Biggest local-quality ceiling; local-first friendly | L | High | ✅ 2026-09-30 — enrichment shipped: embedder input is `path · heading + content`, schema v2 forces one re-chunk, reranker sees enriched docs, eval gained an enrichment case (RRF + reranker were 5cb6c66) |
| 8 | Live load-time VRAM estimator (sliders → predicted memory, OOM warn) in the local-model load panel | LM Studio sets this bar; parts exist (auto-NGL, watts) | M | High | ⬜ |
| 9 | Per-model tool-calling badges + raw tool-call debug pane for local models | Trust in local agents | S–M | Medium | ✅ 2026-09-30 — badges (template/likely/forced/disabled) in the picker + Local Models panel, tri-state override in the gear menu ("disabled" skips the tools schema), and the Logs-page tool-call debug pane parses advertised tools + emitted calls (native + Hermes) from the stored bodies |
| 10 | Streaming voice loop: partial whisper transcripts, sentence-level Kokoro streaming, barge-in cancel | Voice becomes "usable," not "demoable" | L | High | 🟡 398e5fd wave — live partials + sentence-level streaming shipped; barge-in still open |
| 11 | Auto-provision a worktree per spawned session/agent (opt-in toggle already exists per chat) | Matches Cursor/OpenCode orchestration norm | S–M | Medium | ✅ 76cbfbc — `worktree_policy: inherit/always/never` per subagent definition, provisioned at spawn |
| 12 | Register or remove quick-action keybindings; add global Alt+Space quick-capture overlay (answers via last provider) | Known dead setting; Raycast/Ollama/Gemini pattern | M | Medium | ⬜ — still DOM-level only (no `global-shortcut` plugin); the Mod+/ cheatsheet overlay (5801806) is in-app |
| 13 | Replace static harness model catalog with live `list_harness_models` (TODO already in code) | Pricing drift; wrong models shown | S | Medium | ✅ 425e322 — live probe with 30 s TTL cache + force-refresh + provenance badges |
| 14 | Auto-refresh pricing table + family-aware cache-read rates; show cache savings in cost dashboard hero | Under-pricing ~5× for OpenAI cache | M | Medium | ✅ 425e322 — daily LiteLLM refresh, explicit cache-read rates, observed-rate layer, cache-savings hero |
| 15 | Budget enforcement mode (warn → pause-at-threshold) as opt-in; per-run live spend projection | Advisory-only today | M | High | ⬜ — still advisory by documented product decision |
| 16 | Checkpoint pruning (count/age-based per session) | Unbounded refs growth | S | Medium | ✅ 2026-10-01 — `checkpoints.max_per_session` (default 50, 0=off) enforced inline after every insert (oldest TURN checkpoints first, baseline always kept so the pre-chat state stays undoable; ≤8 ref deletions per pass to bound turn-finalize latency, self-healing over subsequent turns) plus a boot pass across ALL sessions (`checkpoints::boot_prune`) and `checkpoints.max_age_days` (default 0=off) age pruning; ref deletion never leaves a row stranded and vice versa. Tests cover cap enforcement, baseline preservation, the 0-cap, and age pruning |
| 17 | Backup/export completeness: include memory, automations, improve tables in project zip export | Asymmetric export today | M | Medium | ⬜ |
| 18 | Code-split `babel-standalone` + `flowchart-elk`; lazy-load react-markdown; virtualize AutomationRunTable | Entry chunk ~766 KB and growing | M | Medium | ✅ 2026-09-30 — babel/elk were already split (since 09-06; claim was stale); react-markdown + plugins now lazy (entry 1,182 → 751 KB); AutomationRunTable virtualized |
| 19 | Fix Kimi two-pane session cross-attribution; add session-id source confidence indicator | Documented open bug | S–M | Medium | ✅ 2026-09-30 — claim registry + mandatory recency guard + case-insensitive cwd match; provenance persisted and shown as an `id?` badge |
| 20 | Delete/mount orphans: `DocumentsLibrary`, leftover ProjectItem/SessionRow, `SHOW_FAKE_UPDATE`, dead layout code | Hygiene | S | Low | ✅ 2026-09-30 — all deleted with their orphaned CSS/test; `ensureBrowserTabs` too |
| 21 | Self-host Google Fonts (bundle woff2) | Local-first integrity; cold start | S | Low | ✅ 2026-10-01 — all eight families (Space Grotesk/Mono, Inter, IBM Plex Sans, Roboto, Fraunces variable, JetBrains Mono, Fira Code) bundled via @fontsource packages and imported from `src/styles/fonts.css`; the fonts.googleapis/gstatic links are gone from index.html and the CSP no longer allows them (`csp.test.ts` now asserts they are ABSENT) |
| 22 | Mobile: expo-secure-store migration + push-token cleanup + version sync | Documented skipped items | M | Medium | 🟡 2026-10-01 — the pairing URL (token in its fragment) now lives in expo-secure-store with a one-way AsyncStorage migration and legacy-fallback read chain (`mobile/src/lib/secureStore.ts` + useRelay boot path); desktop push tokens gain a registration timestamp (90-day staleness prune on read) and are cleared when Expo reports `DeviceNotRegistered` (`mobile/push.rs`, tests included). **Still open:** app version sync |
| 23 | Linux decision: pick tier (supported/experimental/unsupported), then fix secrets (proper encryption), OCR fallback, browser drift | Endless half-state is worse than a decision | M + decision | Medium | 🟡 — secrets half is moot (OS keyring already in use; §4.1.6); tier decision + OCR fallback + drift still open |
| 24 | Harness approval parity: extend approval-card relay to Kimi/OpenCode (they support permission flags) or document the gap in-UI | Silent full-auto surprise | L | Medium | ✅ 2026-09-30 — native catalogs for every harness that has one (kimi yolo/auto/plan, omp approval-modes, commandcode permission-modes — 2026-09 docs-verified), adapters map labels to spawn flags, CommandCode headless honors the label (--permission-mode replaces baked --yolo), and pi/ACP get an explicit in-pane-approvals note chip; approval *cards* remain built-in-chat-only, stated in the menu hint |
| 25 | Watcher-driven incremental docs indexing (reuse git-watcher infra); cross-platform OCR fallback path | RAG freshness on Windows + elsewhere | M | Medium | 🟡 2026-10-01 — the watcher half landed: `docs_watcher.rs` (one notify watcher per enabled corpus root, 2 s debounce / 15 s burst cap, enabled-at-fire-time check, skip when a job is in flight) re-runs the incremental index through the same `spawn_index_job` as the Index button; installed on boot, corpus add, and enable. **Still open:** cross-platform OCR fallback |
| 26 | Mesh turn-end hooks + Settings section + eval scenarios (close Session Mesh P4) | P4 partial; polling latency | M | Medium | ✅ 2026-09-30 — `mesh_message` / `mesh_turn_complete` lifecycle hooks fire on delivery and watched-turn end (answered/expired; payloads carry from_session/mail_id/mode/preview), a Settings → Session Mesh section hosts the master switch + hook deep-links, and `session_fabric/eval.rs` adds three multi-step scenarios (hook round-trip, question lifecycle, caps under burst) |
| 27 | Improvements engine P3: cross-artifact pack health, flaky-case quarantine, artifact cost attribution in dashboard | Shipped P0–P2; P3 designed | M | Low | ✅ 2026-09-30 — pack health per artifact (active/quarantined/discriminating/suspect "never fails anything" badge), flaky cases auto-quarantined on pass/fail flips across identical eval runs (skipped by gating, releasable in-panel), and per-artifact cost attribution (live runs + the engine's own eval sessions → chat_messages) in the Cost dashboard |
| 28 | Browser: renderer-crash recovery affordance, `upload_file` (allowlist dir), downloads-to-workspace with timeline | Phase-3 differentiators already researched in-repo | L | Medium | ✅ 2026-09-30 — crash recovery (WebView2 ProcessFailed → `browser:crashed` → pane card + Recover re-creates the webview), `browser_upload_file` (workspace-allowlisted, DevTools `DOM.setFileInputFiles`; built-in tool + relay-browser MCP op, gated on browser-live), and downloads now close their timeline story (download_complete with size / download_interrupted) on top of the existing artifacts-dir routing |
| 29 | Connectors: Slack/Linear/Jira additions + connector health dashboard (token expiry surfacing) | On roadmap; clear enterprise pull | M–L | Medium | ⬜ |
| 30 | Second git host: GitLab (REST + connector) | Reduces single-vendor risk | L | Medium | ⬜ — GitLab remotes explicitly rejected |

---

## 6. New feature proposals (grouped, prioritized)

### Tier 1 — strategic, do next quarter
1. **Windows sandbox stack for agent execution** (S/J + restricted token + AppContainer + per-domain network proxy allowlist; Codex/MXC blueprint). *Impact: unlocks full_auto honestly, unattended automations, and enterprise credibility. Effort: XL, incremental (Job Objects first).* [research]
2. 🟡 **MCP 2026 client upgrade pack**: stateless `_meta` request model + `server/discover`, MRTR input loop wired into the existing approval card UI, Tasks extension, CIMD OAuth in connectors, official registry in the gallery with verification badges. *Impact: keeps the app's core interop current; Relay already has strong MCP bones (client + gallery + 2 servers). Effort: L each, ship as a series.* [research] — **two pieces shipped 2026-10-01**: the registry (`mcp_registry_search` + status-badged results + one-click install, §4.3.3) and **tool annotations into the permission ladder** (§5.4). The client-series items (stateless `_meta`, `server/discover`, MRTR, Tasks, CIMD) remain.
3. **MCP Apps host** (SEP-1865): render tool-provided UIs in Relay's existing sandboxed-iframe + postMessage infrastructure (already battle-tested by JSX/HTML previews). *Impact: first-mover desktop host; makes connectors/MCP visually first-class. Effort: L.* [research]
4. 🟡 **Hooks + triggers automation pack**: pre/post-tool hooks (5.5) + inbound webhook/file-watch/git/email triggers (5.6) + approval-gate step inside automation runs + chained automations. *Impact: turns automations from "cron for prompts" into a local n8n-class surface — a real differentiator when combined with run-while-closed. Effort: L–XL total.* [research] — **hooks + triggers shipped 2026-09-21/26** (7ff4df6, 2150eb5); approval-gate step and chained automations remain.
5. ✅ **Declarative subagents ("Crew")**: user-defined named agents (prompt, tool allowlist, permission scope, model, worktree policy) stored in DB, spawnable via UI, `Task`, `spawn_session`, and automations; auto-provision worktrees. *Impact: converts Session Mesh + subagents into a product; matches the Claude Code `.md` subagent economy. Effort: L.* — **shipped 2026-09-24/26** (76cbfbc registry + five spawn surfaces + `.md` interchange; 7f0c510 agent-authored CRUD with carded consent; d5d0235 harness-authored definitions read-only by default; worktree auto-provisioning included).
6. 🟡 **Skills marketplace v1**: install-from-URL, SKILL.md progressive-disclosure loader, publish Relay-native skills (browser control, doc-gen, research), gallery with the MCP registry pattern (namespace verification). *Impact: rides the Agent Skills standard (Anthropic/OpenAI/Microsoft adopting); cheap distribution. Effort: M–L.* [research] — **shipped 2026-10-01** (§4.3.4): install-from-URL, the frontmatter metadata layer, the browsable Gallery (curated 12-entry catalog, live-verified per entry, installs through the standard validated URL installer), and packaged Relay-native expertise (three bundled loops materialized on first run). A third-party publishing/namespace-verification story remains.
7. ✅ **Inline edit-review posture**: optional "confirm edits" mode that intercepts write/edit tools with per-hunk accept/reject cards for users who don't want full-auto. *Impact: closes the biggest interaction-model gap vs Cursor/Cline without abandoning full-auto. Effort: L.* [research] — **shipped 2026-10-01** as the `confirm_edits` posture (§4.2.5): occurrence-level review computed from the real file, partial accept applies only the kept occurrences.
8. **OTel GenAI trace export + agent run timeline**: per-session/automation trace (spans per tool call with IO/diff previews), OTLP export toggle, `traceparent` into MCP `_meta`; timeline UI reusing the browser-timeline component. *Impact: observability is unserved in desktop shells; doubles as debugging + trust UX. Effort: L.* [research]

### Tier 2 — high-value differentiators
9. **Real-time voice mode**: streaming STT + streaming Kokoro + barge-in; later evaluate Moshi/Ultravox local speech-to-speech sidecar. *Effort: L–XL.* [research] — **researched 2026-09-30**, see `docs/research/REALTIME_VOICE_MODE_RESEARCH.md`: phased plan (A barge-in → B streaming-zipformer partials → C callback-streamed Kokoro → D voice-session UX), with S2S deferred — Moshi is full-duplex at ~200 ms but needs WSL2 + 10–20 GB VRAM and no 2026 S2S model calls tools, so the text-mediated pipeline stays the agent's voice.
10. **System-wide dictation + quick capture**: global hotkey overlay (Alt+Space) that dictates/asks from any app using the existing whisper + provider stack; optional "type into focused window." *Effort: M–L.* [research]
11. **OpenAI-compatible local endpoint**: expose Relay's llama-server sidecars (and a stateful `previous_response_id` API) on loopback so ChatGPT/Claude Desktop/other tools can use Relay's models — free distribution, Ollama's playbook. *Effort: M.* [research]
12. **`relay daemon` headless mode + `relay chat` CLI**: run sidecars/automations/mesh without UI; enables home-server deployments and SSH use. *Effort: M–L (sidecar binaries already exist).* [research]
13. ✅ **Multi-model compare view**: fork a thread to 2–3 models side-by-side (panes exist), vote/merge the winner; auto-compact shared prefix for cost. *Effort: M–L.* — **shipped 2026-09-22** (5801806: fork to 2–4 side-by-side panes with per-pane model pick + equalized ratios; Mod+/ cheatsheet). Vote/merge and shared-prefix compaction remain open.
14. **Auto model routing Phase 4**: OpenRouter `auto` as ranking source, learned router from thumbs-down/retry feedback, TTFB-aware ranking (telemetry already collected). *Effort: M.* [code: Phase 4 designed in-repo]
15. ✅ **Project wiki / repo knowledge** — **shipped 2026-10-01** (same day as the research): `src-tauri/src/wiki/` + `db/wiki.rs` implement the researched design — deterministic repo analysis (walk + git-log themes) → one outline call → one generation call per page, every page ending in a **Grounded-Claims ledger** (claim → path + line range + blob SHA) validated against the real repo before storage; freshness is COMPUTED (`git diff old..new` joined against `wiki_claims.evidence_path` — affected pages regenerate from their stored briefs, clean repos cost ZERO model calls) driven by a boot freshness task (60s HEAD re-check) plus manual Update; `search_wiki`/`read_wiki_page` tools through the registry + relay-tools bridge (all harness CLIs share the wiki), the page index layers beside AGENTS.md (capped, firewalled, `wiki.layer_index`); build models: any cloud provider (summarizer-chain fallback) OR any harness CLI via `harness_oneshot_text` (the CLI's own auth — subscriptions/free tiers work), with step-feed progress events (`wiki:build:progress`) rendered in the tool-panel Wiki tab + overlay reader. Surfaced: `ActiveView "wiki"` overlay, singleton ToolPanel tab, Settings → Wiki. Live-verified end-to-end on this machine: a real OpenRouter-model build (4 pages) + real update pass (2 pages regenerated from a real commit), and a real OpenCode-harness build (5 pages) + update pass. Deferred (Phase D per the research doc): LLM-judge groundedness pass, Vault/repo export, page history, mobile view. Research: `docs/research/PROJECT_WIKI_RESEARCH.md`.
16. ✅ **Packaged PR review bot**: automation template that reviews open PRs on schedule with the GitHub review tools + posts review comments (Bugbot pattern); include eval pack. *Effort: S–M (parts all exist).* [research] — **shipped 2026-10-01** (`automation_templates.rs`): the PR-review-bot + repo-digest templates prefill the standard Automations form (Pull Requests panel has a "Review bot" entry too). The eval pack remains open.
17. ✅ **Phone → desktop task dispatch**: compose a task on mobile → runs as a desktop automation/session with push on completion (extends the pairing channel; Claude Cowork pattern). *Effort: M.* — **shipped 2026-09-26** (398e5fd: phone composer dispatches into desktop sessions; automations CRUD from the phone in the same wave).
18. ✅ **AGENTS.md support**: read/layer project `AGENTS.md` into harness bundles + built-in chat context; author/update via tools. *Effort: S.* [research] — **shipped 2026-10-01** (§4.2.10): layered into both prompt surfaces with ancestor discovery; `read_agents_md` / `write_agents_md` in the registry.
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
CI tests + clippy (5.1) ✅ · installer signing + winget (5.2) 🟡 · Windows sandbox layer 1: Job Objects (5.3) · MCP tool annotations → permissions (5.4) ✅ · hooks system (5.5) ✅ · keybindings register-or-remove + Alt+Space capture (5.12) · live harness model catalog (5.13) ✅ · checkpoint pruning (5.16) ✅ · orphan cleanup (5.20) ✅.
*(The 2026-10-01 fourth pass retired 5.4 and 5.16; 5.2 is scaffolding-complete pending the certificate + winget submission — external actions. Of this wave, 5.3 sandbox and 5.12 keybindings are the remaining open items, and 5.3 is now the last big trust gap. The §4.1.4 exec-gate seal joined the §4.1.5 replay and §4.1.8 firewall closures on the trust list.)*

**Next (1–3 months) — ecosystem + quality:**
MCP 2026 client series (6.2) 🟡 · automation triggers pack (5.6) ✅ · hybrid RAG + reranker (5.7) ✅ · VRAM estimator (5.8) · declarative subagents + worktree-per-agent (6.5, 5.11) ✅ · confirm-edits posture (6.7) ✅ · skills gallery (6.6) ✅ · streaming voice loop (5.10) 🟡 · budget enforcement (5.15) · OTel traces (6.8).
*(The 2026-09-30 second pass also cleared 5.9, 5.24, 5.26, 5.27 and 5.28; the 2026-10-01 third pass cleared 6.7, 6.16, 6.18 and the registry half of 6.2; the same-day fourth pass cleared 6.6, the annotations piece of 6.2, and the OpenAI half of 4.3.7.)*

**Later (3–6+ months) — reach + frontier:**
macOS/Linux + platform tier (6.21) · MCP Apps host (6.3) · real-time voice (6.9) · local OpenAI-compatible endpoint + daemon mode (6.11/6.12) · multi-model compare (6.13) · routing Phase 4 (6.14) · project wiki (6.15) ✅ shipped 2026-10-01 · A2A (6.19) · mobile v2 (dispatch, automations CRUD, previews) (6.17) · GitLab + Slack/Linear/Jira connectors (5.29/5.30) · i18n (6.28) · computer-use decision (6.30).

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
