# Conduit — Competitor Analysis & Gap Report

> **Date:** 2026-08-14 · **Method:** live web research (primary sources: vendor sites, pricing pages, GitHub READMEs; URLs cited throughout) cross-referenced against a full read of the Conduit source tree. Companion document: `FEATURE_AUDIT_AND_IMPROVEMENTS.md`.

---

## 1. What Conduit is (for positioning)

A **local-first orchestration shell (Windows-shipping today, cross-platform code)** with a **unified chat-first layout**: the chat view is the permanent center surface with a composer **agent selector** (installed CLI harnesses — Claude Code / Kimi / OpenCode — running headless in-chat, API-based models, or local GGUF), while interactive PTY terminals and browser panes live as tabs in a collapsible right-hand ToolPanel alongside diffs, canvas, and agents; a built-in multi-provider chat with a 32-tool agent loop; **local GGUF inference** (llama-server sidecar, Hugging Face market, GPU-offload ladder, context compaction, vision/mmproj); native browser panes with **MCP agent control**; git tooling with AI commit messages + plan tracking; 11 OAuth/remote-MCP connectors; **headless cron automations** (incl. a standalone binary that runs while the app is closed); a cross-agent **cost dashboard**; and a **React Native mobile companion** over a localhost WebSocket relay.

---

## 2. The landscape (August 2026)

### 2.1 AI coding IDEs & CLIs

| Tool | What it is | Notable features | Pricing | Source |
|---|---|---|---|---|
| **Cursor** | VS Code-fork AI IDE | Agent w/ MCP+skills+hooks, **cloud agents**, Bugbot code review, automations (Teams); **acquired Continue.dev** | Free / Pro $20 / Ultra / Teams $40/user | cursor.com/pricing |
| **Claude Code** | Anthropic CLI + desktop + mobile + web | Agent SDK, subagents, background agents, hooks, GH Actions, **Routines/scheduling**, session teleport, headless CI mode | In Claude plans $20–$200/mo | code.claude.com/docs |
| **Devin Desktop** (ex-Windsurf; Cognition acquired Jul 2025) | Multi-agent "command center" IDE | Kanban, Spaces (worktrees), cloud handoff, **ACP interop** (Codex/Claude/OpenCode), free unlimited SWE-1.6 model | Free / $20 / $200 / Teams | devin.ai/desktop |
| **GitHub Copilot** | Extension + CLI + cloud agent | Agent mode (all major IDEs), async coding agent opening PRs, code review, huge model roster (Claude/GPT/Gemini/Grok/Kimi) | Free / Pro $10 / Pro+ $39 / Max $100 | github.com/features/copilot/plans |
| **Zed** | Rust editor | Agent panel, Zeta edit predictions, **local models via Ollama**, created **ACP** (agent client protocol) | OSS + hosted models | zed.dev/ai |
| **Aider** | Terminal pair-programmer | **Local models**, auto-commits, repo map, voice, lint/test loops; 44k★ | Free BYOK | aider.chat |
| **OpenCode** | OSS TUI + desktop app (beta) | **Multi-session parallel agents**, 75+ providers incl. local, free models, 195k★ | Free + Zen paid models | opencode.ai |
| **Cline** | OSS VS Code ext + CLI + SDK | Plan/Act, checkpoints/undo, **MCP marketplace**, multi-agent delegation, **cron schedules**, **local via Ollama/LM Studio** | Free BYOK | cline.bot |
| **Roo Code → Roomote** | Pivoted to self-hosted cloud coding teammate | Slack/Discord/mobile-web control, unlimited concurrent tasks, BYOK incl. local | $49–499/mo; self-host free ≤10 users | roomote.dev |
| **Google Jules** | Async cloud agent | Plan→diff→PR on Cloud VMs; free 15 tasks/day → Ultra 300/day, 60 concurrent | Free–Ultra | jules.google |
| **OpenAI Codex** | Cloud agent + CLI + IDE ext | Command center, worktrees, **scheduled background work**, unified ChatGPT account | ChatGPT plans | openai.com/codex |
| **Amp** (Sourcegraph) | Terminal + editor agent | Subagents, Oracle second-opinion, shareable threads, **zero-markup overage** | Subscription + API-cost overage | ampcode.com |
| **Kiro** (AWS) | Agentic IDE + CLI + web | Spec-driven dev, parallel agents, **cloud automations/hooks**, MCP+ACP | Free 50 credits → $200/mo tiers | kiro.dev |
| **Trae** (ByteDance) | AI IDE | SOLO mode, concurrent cloud tasks, aggressive pricing | Free / $3 / $10 / $100 | trae.ai |
| **Goose** (Block→Linux Foundation) | OSS agent runtime (Rust) | Desktop+CLI+API, **Ollama local models**, **ACP server**, 70+ MCP extensions, Recipes (YAML workflows in CI), sandbox mode | Free | goose-docs.ai |
| **Void** | OSS Cursor-alternative IDE | No private backend, checkpoints, Fast Apply, self-hosted models | Free beta | voideditor.com |

### 2.2 Local-model runners

| Tool | Focus | Key facts | Source |
|---|---|---|---|
| **LM Studio** | Local inference desktop app | llama.cpp + MLX, in-app downloads, SDKs + `lms` CLI, new **"Bionic" agent** (coding, automations, computer control, local voice) | lmstudio.ai |
| **Ollama** | Local model runtime | CLI + desktop, tool-calling/vision/thinking model tags, **Ollama Cloud** hybrid | ollama.com |
| **Jan** | OSS ChatGPT replacement | Local + online providers, 6M+ downloads | jan.ai |
| **GPT4All** | Local chat + **LocalDocs RAG** | Document-grounded Q&A, all desktop OSes | nomic.ai/gpt4all |
| **AnythingLLM** | RAG + agents, MIT | Desktop/Docker/**mobile app**, **background/scheduled jobs**, hardware-aware model picks, 5M+ Docker pulls | anythingllm.com |
| **llama.cpp** | Upstream engine (Conduit's sidecar) | `llama-server` OpenAI-compatible + web UI; CUDA/Metal/Vulkan/HIP/SYCL; 124k★ | github.com/ggml-org/llama.cpp |

### 2.3 Orchestration shells & multi-agent managers (closest analogs)

| Tool | Platform | Parallel agents | Worktrees | Local models | Mobile | Automations | Status | Source |
|---|---|---|---|---|---|---|---|---|
| **T3 Code** (Theo Browne / pingdotgg) | **Win (winget)/Mac/Linux + iOS/Android + web + headless server** | ✅ "control plane for coding agents" — Claude Code, Codex, Cursor, Grok Build, OpenCode | Branch-per-thread + **per-turn git checkpoints w/ revert** | ❌ (bring your own subscription) | ✅ **native iOS/Android apps + hosted web app (app.t3.codes)** | ❌ (but **Linux systemd background service** + headless `t3 serve`) | **🔥 Viral — 18.7k★ in ~6 months, MIT**, Electron + Effect RPC, "very very early" | github.com/pingdotgg/t3code · t3.codes |
| **Conductor** (Melty) | **macOS only** (cloud on Linux) | ✅ core | ✅ | ❌ | "coming very soon" (Pro) | ❌ | Active; Free/$50/mo Pro | conductor.build |
| **Nimbalyst** (ex-Crystal) | **Win/Mac/Linux + iOS** | ✅ kanban | ✅ | ❌ | ✅ iOS | ❌ | Active, MIT, free | nimbalyst.com |
| **Vibe Kanban** (BloopAI) | Desktop/self-host | ✅ 10+ harnesses | ✅ | ❌ | ❌ | ❌ | **⚠️ sunsetting** (27.8k★) | github.com/BloopAI/vibe-kanban |
| **Claude Squad** | Unix (tmux) | ✅ | ✅ | ❌ | ❌ | Background tasks | Active, AGPL | github.com/smtg-ai/claude-squad |
| **Superset** | **macOS (+exp. Linux), no Windows** | ✅ any CLI | ✅ | ❌ | ❌ | ✅ **cron automations** + MCP server | Active, ELv2 | superset.sh |
| **Happy Coder** | iOS/Android/Web | Single-session handoff | — | ❌ | ✅ **core, E2E encrypted**, push | ❌ | Active, MIT, 23k★ | happy.engineering |
| **Omnara** | Cloud/self-host | Durable agent infra | — | BYOK incl. Ollama | — | ✅ | Pivoted to agent infrastructure | github.com/omnara-ai/omnara |
| **VibeTunnel** | macOS/Linux | Terminal→browser | — | ❌ | via browser | ❌ | Active, MIT | vibetunnel.sh |
| **Conduit** (this project) | **Windows** (code cross-platform) | ✅ harnesses run **chat-first** (headless CLI chat via composer agent selector: harness / API / local GGUF); optional interactive PTY terminals as ToolPanel tabs | ✅ | ✅ **GGUF + HF market + GPU ladder** | ✅ RN app + WS relay | ✅ **headless cron, runs closed** | Active | — |

---

## 3. Gap analysis — what competitors have that Conduit lacks

### 3.0 Deep-dive: T3 Code — the new direct threat (researched 2026-08-14 from repo docs + source)

**T3 Code** (github.com/pingdotgg/t3code · t3.codes) is Theo Browne's open-source "control plane for coding agents." Repo created **2026-02-08**, already **18.7k★ / 4.3k forks / 1,874 open issues**, commits pushed daily. Free (MIT) — "we're selling Nothing"; you bring your existing Claude/Codex/Cursor/Grok/OpenCode **subscriptions** ("No keys resold. No quota caps."). Marketing claims "tolerated by over 100,000 devs" and leans on performance ("proof electron apps don't have to suck").

**Architecture (from `docs/internals/overview.md`) — more serious than "wrapper":**
- **Server-authoritative design:** a Node **server runtime owns everything** — agent sessions, workspaces, terminals, git, filesystem. Clients (Electron desktop, web, Expo mobile) are thin views talking over **one authenticated Effect RPC WebSocket** with **per-method scope authorization** (holding a socket ≠ calling everything).
- **Event-sourced orchestration engine:** clients dispatch typed commands → decider produces events → single SQL transaction appends to the event store + updates projections → committed events published to subscribers. Retries are idempotent via durable command receipts. This buys them **multi-client state sync for free** (pinned-thread order syncs across desktop and phone).
- **Per-turn checkpoints via hidden git refs:** every turn is bracketed by workspace checkpoints; diffs and **reverts are exact** (revert restores both the workspace *and* the provider conversation). This is Cline-checkpoints-grade, built into the core loop.
- **Provider driver registry:** 5 built-in drivers behind a driver/adapter split — adding an agent = one driver + one adapter, no orchestration or client changes.
- **Remote access done properly:** `t3 pair` mints one-time QR pairing tokens without restart; **Tailscale Serve HTTPS integration**; headless `t3 serve`; **desktop-managed SSH launch** (probes host, starts/reuses a remote server, port-forwards back); optional **T3 Connect** hosted relay (Clerk auth + PlanetScale) for zero-config remote — the one cloud component, and it's optional/self-hostable.
- **Background service:** `npx t3 service install` → **systemd user service** with a versioned launcher that snapshots the DB before remote updates (rollback on failure). Their "runs when the GUI is closed" story is *shipped*, not 90%-built.
- **Permission modes shipped and wired:** 4 per-thread modes (Supervised / Auto-accept edits / Auto / Full access) mapped onto each provider's native sandbox/approval semantics (Codex AI-reviewer delegation, Claude auto mode), inline approvals, same modes on mobile. *(Compare: Conduit's 4-mode system exists backend-side but the UI was removed and files are dead code.)*
- **Git-hosting integrations beyond GitHub:** GitHub + **GitLab + Bitbucket + Azure DevOps** — clone from hosting, publish local repos, create PR/MR with AI titles/bodies/changelogs, **PR review tabs in the right panel**, edit PR title/description/comments in place, draft/stack/amend support, one-button branch-per-thread commit+push+PR.

**Where T3 Code beats Conduit today (hard truths):**
1. **Checkpoints/revert** — Conduit has no turn-level checkpointing at all.
2. **Permission UX shipped** vs Conduit's dead-code permission UI.
3. **Multi-client sync & web app** — Conduit has desktop + mobile only; T3 adds a hosted web client and server-synced state across devices.
4. **Remote-access maturity** — Tailscale/SSH/hosted-relay vs Conduit's LAN WS relay with a hardcoded dev IP default and no TLS.
5. **Closed-app story shipped** — systemd service vs Conduit's "Task Scheduler entry is the only piece left to add."
6. **Git-hosting breadth** — 4 providers with in-app PR review vs GitHub-only connector + "Send PR" prompt.
7. **Distribution & funnel** — `npx t3@latest` install-free trial, winget/Homebrew/AUR, App Store/Play Store presence, and Theo's audience. Conduit: GitHub Releases NSIS only.
8. **Zero-setup auth** — reuses existing CLI logins; Conduit additionally asks for API keys for its built-in chat.

**Where Conduit still wins (the moat to defend):**
1. **Local GGUF models** — market, GPU ladder, compaction, vision. T3 Code is subscription-CLIs-only, structurally (a control surface for other vendors' agents won't bundle inference).
2. **Built-in agentic chat** — 32 tools, research mode, artifacts/documents, source ledger. T3 Code has no chat of its own; no chat → no Conduit-style tooling.
3. **Headless cron automations** logged as chat sessions. T3 has no scheduler.
4. **OAuth connectors** (Notion/Google×7/Gmail/GitHub) as per-turn MCP tools.
5. **Agent-controllable browser panes** with MCP + visual feedback.
6. **Cross-agent cost dashboard.**
7. **No account, no cloud, no Clerk** — Conduit is *fully* local-first; T3 Code's smoothest remote path funnels users toward their hosted relay + Clerk accounts.

**Implication:** T3 Code validates Conduit's entire category (server-authoritative shell + thin mobile client = exactly Conduit's relay architecture) while out-executing on distribution, checkpoints, permissions, and remote access. The response is not control-surface parity — it's (a) shipping the half-built things T3 already ships (checkpoints, wired permission UI, Task Scheduler registration, proper remote pairing/TLS), and (b) doubling down on what they structurally can't copy: local models + built-in agentic chat + automations.

---

Ranked by how much they matter for Conduit's actual positioning (orchestration shell, not IDE):

### 3.1 High-priority gaps (directly competitive)

1. **Worktree-per-session isolation as a first-class default.** Conductor, Superset, Claude Squad, Vibe Kanban, Nimbalyst, Devin Spaces, and T3 Code (branch-per-thread) all treat "every agent gets its own isolated workspace" as *the* core mechanic. Conduit has `create_worktree` but it's a context-menu action, not the default session model. Two agents in the same cwd (incl. the known Kimi cross-attribution risk) is the norm today. **This is the biggest conceptual gap vs the orchestrator cohort.**
2. **Per-turn checkpoints & one-click revert.** T3 Code brackets every turn with hidden-git-ref checkpoints (exact diffs, revert restores workspace *and* conversation); Cline has checkpoints/one-click undo. Conduit has nothing — a bad agent turn can only be undone with manual git surgery. With worktrees (gap #1) this becomes cheap to implement.
3. **PR-centric workflow.** Jules/Codex/Copilot are PR-producing machines; Vibe Kanban/Nimbalyst center diff review + PRs; T3 Code ships 4-provider PR review tabs. Conduit's "Send PR" button types a prompt into a terminal. The GitHub connector makes real PR create/review/status feasible — it's the most obvious missing loop-closure.
4. **Persistent/restorable sessions across restarts.** Superset's headline feature. Conduit kills panes on quit and restores nothing despite having resume-by-id for all three harnesses.
5. **Autocomplete / edit prediction.** Cursor Tab, Copilot, Zed Zeta, Windsurf Supercomplete. **Structurally unreachable** for a terminal-tiling shell — accept this and don't chase it; it's the reason to keep positioning as "orchestrator for CLI agents," not an IDE.
6. **Kanban/board view of agents.** Devin Desktop, Nimbalyst, Vibe Kanban converge on this. Conduit's unified chat + ToolPanel-tab model is power-user-good but has no status-at-a-glance board across all running agents (waiting/working/diff_ready states already exist as data — the view is the missing piece).
7. **Document RAG (LocalDocs-class).** GPT4All/AnythingLLM define it; Conduit's chat can't ground answers in a local document corpus despite having local embeddings infrastructure one sidecar away.

### 3.2 Medium gaps

8. **Automated code review agents** (Bugbot, Copilot review, Roomote second-model review). Conduit has the model plumbing + git diff access; a "Review this diff" quick action is near-free.
9. **Cloud execution.** Jules/Codex/Devin run agents in cloud sandboxes — Conduit is deliberately local-machine-bound. Out of scope for local-first philosophy, but worth stating as a conscious trade-off.
10. **ACP interoperability.** Zed, Devin Desktop, Kiro, Goose, OpenCode are converging on ACP while Conduit speaks MCP only. ACP client support would let Conduit orchestrate Zed/Devin-ecosystem agents; not urgent, strategically worth watching.
11. **E2E-encrypted mobile access + push notifications** (Happy Coder, 23k★). Conduit's relay is token-gated but unencrypted beyond the LAN, and the phone must be foregrounded.
12. **macOS/Linux releases.** Every orchestrator competitor is Mac-first; the broader market (Cursor/Claude Code/Zed/Goose) ships all three OSes. Conduit's code is cross-platform but distribution is Windows-only — a growth gate, not a defect.
13. **Free frontier-model access** (Devin's SWE-1.6, OpenCode free models, Copilot Free, Jules free tier). Conduit requires BYOK or local hardware — higher setup friction at the top of the funnel.
14. **MCP marketplace / one-click installs** (Cline). Conduit's connectors are curated-first-party; there's no user-installable MCP server gallery for the chat (harnesses get MCP via the bundle, but the built-in chat only gets connectors).
15. **Voice** (LM Studio Bionic local voice, Happy voice control). Emerging; whisper.cpp sidecar fits Conduit's existing pattern.

### 3.3 Gaps Conduit should NOT chase

- **Being an IDE** (autocomplete, editing surfaces) — explicitly out of scope in the PRD and structurally wrong for the architecture.
- **Cloud agent VMs** — contradicts local-first; Omnara/Omnara-style "durable agents" are a different product.
- **Enterprise surface** (SSO/SCIM/audit) — no demand signal from the current single-user design.
- **Tab-style completion** — same reasoning as #4.

---

## 4. Where Conduit is genuinely ahead (defensible differentiators)

1. **Local GGUF inference + multi-CLI orchestration in one app.** *Nobody else combines these.* LM Studio/Ollama/Jan do inference but not agent tiling; Conductor/Superset/Nimbalyst orchestrate but have zero local-model support; Goose has local models but is an agent, not an orchestrator. This is the moat — invest here (see Part 2 of the companion doc).
2. **~~Windows-first in a Mac-centric category.~~** *Revised 2026-08-14:* Superset has no Windows, Conductor is macOS-only, Claude Squad needs tmux — but **T3 Code ships Windows via winget** with native mobile apps, so this is no longer a clean moat. Conduit remains one of only two serious Windows-capable orchestration shells, and the only one with local-model integration.
3. **Headless cron that survives app shutdown** (standalone `conduit-automation` binary). Superset and Cline have cron; Codex/Kiro have cloud-scheduled work; a *local* scheduler that runs with the GUI closed is rare — and it's 90% built (Task Scheduler registration is the missing piece).
4. **Native browser panes with MCP agent control** (agents driving the browser with visual feedback). Vibe Kanban's preview browser was closest and it's sunsetting; Cline's browser tool is an extension feature, not an orchestrator surface.
5. **Cross-agent cost dashboard** aggregating Claude Code/Kimi/OpenCode/local-GGUF spend with read-time repricing. Amp has usage accounting; nobody aggregates across heterogeneous local CLIs.
6. **Multi-agent mobile companion without a cloud middleman.** Happy Coder is single-agent (but E2E-encrypted — the bar to beat); **T3 Code ships native iOS/Android apps + a web app** with remote access, making mobile table stakes for the category now; Nimbalyst iOS manages sessions but no local models. Conduit's remaining mobile edge is scope: multiple agents *and* local-GGUF chat *and* approvals, all relayed without a cloud account.
7. **First-party OAuth connectors** (Notion/GitHub/Google×7/Gmail) baked into the shell with REST fallbacks — competitors delegate all of this to third-party MCP servers.

---

## 5. Market dynamics & timing (why now)

- **Consolidation/churn creates orphaned users:** Windsurf→Devin Desktop (Cognition), Cursor acquired Continue, **Vibe Kanban is sunsetting (~27.8k★)**, Crystal deprecated for Nimbalyst, Roo pivoted to Roomote. Indie orchestration users are actively looking for new homes in 2026 — but note **T3 Code (18.7k★, viral) is currently the strongest magnet for those users**, being free, open-source, cross-platform, and mobile-native. Conduit must compete with it on the axes T3 structurally lacks (local models, built-in chat tooling, automations, connectors), not on "control surface" parity.
- **"Command center" is the convergent form factor** (kanban + worktrees + diff review + fleet status). Conduit has the underlying pieces (states, worktrees, diffs) but not the board metaphor — cheap to add, expected by incoming users.
- **Scheduled/background agents are table stakes now** (Claude Routines, Codex scheduled work, Cline cron, Kiro automations, AnythingLLM jobs). Conduit matches this — and should finish the "runs while closed" story before competitors' local stories mature.
- **Local models keep moving up-market:** llama.cpp ~124k★; LM Studio shipping an agent; frontier open weights (GLM 5.2, Kimi K3, DeepSeek V4 Pro) distributed through local runtimes; Zed/Goose/Cline/OpenCode/Void all treat Ollama-class inference as first-class. Conduit's integrated GGUF market + GPU ladder + compaction is ahead of most *orchestrators* and behind LM Studio's *polish* — close that polish gap while the orchestration lead holds.
- **Pricing pressure:** $100–200/mo power tiers everywhere (Cursor Ultra, Copilot Max, Claude Max, Kiro Power, Devin Max) + zero-markup BYOK (Amp) + genuinely useful free tiers. A local-first shell with BYOK + free local inference is structurally well-positioned for cost-sensitive power users — the cost dashboard should *show* that savings story ("you saved $X vs Claude Max this month").

---

## 6. Recommended priorities (gap-closure order)

| Priority | Action | Closes gap / defends moat | Effort |
|---|---|---|---|
| P0 | ~~**Worktree-per-session default** for new agent sessions (+ migration nudge)~~ **DONE** (`92f7596a`) | §3.1.1 — the core orchestrator mechanic | M |
| P0 | ~~**Per-turn checkpoints + one-click revert** (hidden git refs, à la T3 Code/Cline)~~ **DONE** (`4ca284a1` + `b81a0fb9`) | §3.1.2 — T3's signature safety feature | M |
| P0 | ~~**Wire the permission-mode UI end-to-end** (or delete it)~~ **DONE** (`ff0b812f`) | §3.0 — T3 ships 4 wired modes; Conduit's are dead code | S–M |
| P0 | ~~**PR create/review/status via GitHub connector**~~ **DONE** (`a7e575c7`) | §3.1.3 — closes the git loop | M |
| P0 | ~~**Restore panes/sessions on launch**~~ **DONE** (`263fac10`) | §3.1.4 — Superset parity, cheap (Workspaces IPC exists, unwired) | S–M |
| P0 | ~~**Finish local-model onboarding polish** (recommendations, wizard, cached NGL, remove personal-path hacks)~~ **DONE** (`d64895d5` + `0bdd2034` — recs; LM Studio-style runtime tweaks incl. cached last-good ngl, HF catalog cache, first-run onboarding banner; personal-path hacks were already clean) | §4.1 — protect the moat | S–M |
| P1 | ~~**Agent board view** (status-at-a-glance over existing pane states)~~ **DONE** — *the existing SubagentPanel (right tool panel "Agents" tab) + GitToolsSidebar agents list already cover per-session agent status; added a "Now" activity strip to the GitToolsSidebar (streaming chats + in-flight automations) to close the at-a-glance gap without a duplicate full-page view* | §3.1.6 — convergent UX expectation | M |
| P1 | ~~**Task Scheduler registration + automation notifications (incl. mobile push)**~~ **DONE** (`acb0ad3c`) — Windows-only schtasks by design; mobile push is relay-broadcast (app-open) | §4.3 — complete the headless story; T3's systemd service already shipped theirs | S–M |
| P1 | ~~**Remote-access hardening** (TLS/Tailscale-style guide, remove hardcoded dev IP, fix relay perf trio, attachments)~~ **DONE** — *dev IP gone, loopback bind + pairing token + perf done; Tailscale `serve` (cross-network TLS) + QR pairing flow + phone attachment picker shipped* | §3.0 — T3's pairing/Tailscale/SSH sets the bar | S–M |
| P1 | ~~**LocalDocs-class RAG**~~ **DONE** — *search_docs tool + corpora + embedding sidecar (`1cfc86fb`); now also: per-turn auto-retrieval injection (latest user message embedded + top hits prepended as "Retrieved context"; works across OpenAI/Anthropic streaming + tool loops), per-chat corpus pinning via Settings → Knowledge (`chat_documents` table + attach/detach commands), and harness/MCP exposure (search_docs added to the conduit-tools MCP server + CLI harness .mcp.json)* | §3.1.7 + local-model moat | M |
| P2 | ~~**"Diff review" AI quick action**~~ **DONE** — `generate_diff_review` Tauri command (per-file + whole-tree, all providers, auto-selects from diffReview settings → chat session provider → first available provider); "🔍 Review" button in DevDiffPanel inline diff detail header; "🔍 Review all" button in panel header; review cards render in-panel with AI review text in a dismissible card; §3.2.8 | §3.2.8 | S |
| P2 | **E2E encryption on the relay** | §3.2.11 — match Happy Coder | M |
| P2 | **MCP server gallery for built-in chat** | §3.2.14 | M |
| P3 | **macOS build job** (when growth > focus) | §3.2.12 | M–L |
| P3 | ~~**ACP client support**~~ **DONE** (`b5bdc8fe`, roadmap #20) | §3.2.10 — watch the standard, don't lead it | L |
| P3 | **Voice input (whisper sidecar)** — *desktop done (`3626bbb5`, roadmap #16); mobile missing* | §3.2.15 | M |

**Strategic summary in one paragraph:** Conduit's defensible position is *the local-model-native orchestration shell with a built-in agentic chat, headless automations, and a no-cloud mobile companion* — the "Windows-first" and "has a mobile app" claims alone no longer differentiate now that **T3 Code** (viral, MIT, cross-platform incl. Windows, native iOS/Android) owns the "control surface for your existing CLI subscriptions" niche. The gaps that matter are the ones the converging "command center" cohort has standardized — worktree isolation per agent, PR-centric flows, session persistence, and a board view — all of which Conduit has the primitives for. The gaps to ignore are IDE features and cloud execution. The single biggest risk is that the local-model experience (the moat) stays at "power-user functional" while LM Studio-class polish sets user expectations and T3 Code matures; the single biggest opportunity is absorbing the users of the sunsetting/pivoting orchestrator cohort (Vibe Kanban, Crystal, Roo) with the one thing T3 Code and the rest can't offer: **local models + a full agentic chat + automations that run while everything is closed.**

---

### Key sources
cursor.com/pricing · code.claude.com/docs/en/overview · claude.com/pricing · devin.ai/desktop · cognition.com/blog/windsurf · github.com/features/copilot/plans · zed.dev/ai · agentclientprotocol.com · aider.chat · opencode.ai · cline.bot · roomote.dev · jules.google · openai.com/codex · ampcode.com/manual · kiro.dev/pricing · trae.ai/pricing · goose-docs.ai · voideditor.com · lmstudio.ai · ollama.com · jan.ai · nomic.ai/gpt4all · anythingllm.com · github.com/ggml-org/llama.cpp · github.com/pingdotgg/t3code · app.t3.codes · conductor.build/pricing · nimbalyst.com · github.com/BloopAI/vibe-kanban · github.com/smtg-ai/claude-squad · superset.sh · happy.engineering · github.com/omnara-ai/omnara · vibetunnel.sh

*Research conducted 2026-08-14 against live primary sources. Competitor facts change fast — re-verify before roadmap commitments.*
