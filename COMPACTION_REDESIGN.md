# Compaction Redesign — Investigation & Proposal

*2026-09-02. Investigation of context compaction quality across Relay's three execution
paths (local models, cloud models, harnesses), followed by a research survey of how the
best systems do it and a redesign proposal.*

---

## 1. Current state

Relay has three completely different context-management stories, sharing almost no code:

| Path | Mechanism | Quality |
|---|---|---|
| **Local (LocalGguf)** | Pin N exchanges + summarize aged-out head via the same sidecar (`src-tauri/src/chat/compaction.rs`) | Real compaction, but lossy in predictable ways |
| **Cloud (Anthropic / OpenAI / OpenRouter / compat)** | **None.** Full DB history re-sent every turn (`src-tauri/src/chat/commands.rs:1767` gate, `:1962-1964` passthrough) | Overflow = terminal raw 400 banner |
| **Harnesses (Claude Code, Kimi, opencode, ACP)** | Delegated to the CLI; Relay is blind (`src-tauri/src/agent_sessions.rs:4757-4760`) | Invisible + a tiny truncate-only primer |

### 1.1 Local models — real machinery, weakest summarizer

**What exists** (`compaction.rs`, orchestrated at `commands.rs:1757-1958`):
- Hybrid pin + summarize: never touch the system prompt, pin the last `pin_exchanges`
  exchanges verbatim (default 6), summarize everything older into a single running
  `[compacted context]` system row; older rows soft-deleted via `superseded_by`.
- Adaptive threshold 0.60–0.85 scaled by `n_ctx`; tool-schema tokens reserved out of the
  budget (`count_json_tokens_cached`); 512-token response headroom.
- User-visible UX is good: `context_compacting` spinner, "Compacted 8.2k → 1.1k tokens"
  notice, summary row carries the summarization call's token usage into the cost dashboard.
- Fallback on any failure: pass history through and let llama-server's context-shifting
  (crude oldest-token dropping) degrade the turn.

**Quality problems, ranked:**

1. **The summarizer is the same small model that already needs help.** A 4K–16K local
   model summarizing 30+ turns of technical conversation is the weakest possible GEN
   engine, with `max_tokens: 1024` capping output (`compaction.rs:460`). Summary quality
   scales with the exact resource the path lacks.
2. **Silent truncation of the summarization input.** The whole aged-out head goes into
   ONE user message; when it doesn't fit, entries are dropped oldest-first at a
   `n_ctx * 3` chars cap (`compaction.rs:607-631`) — logged to stderr only. On a 4K-ctx
   model this routinely discards most of the history the summary claims to cover.
3. **Compounding loss across re-compactions.** The prior summary is folded into the next
   summarization call as text (summary-of-a-summary). This is the exact failure mode
   "Context Compaction Theory" (arXiv 2608.01326) formalizes: repeated GEN compaction
   compounds error, and Anthropic's own production compaction endpoint measured near
   random-guess error on a set-membership benchmark when the summary budget was too
   small. Relay has no mitigation and no summary-quality signal.
4. **No eviction ladder.** Tool outputs (web results, command output, file reads) get
   summarized into prose instead of being evicted as blocks — the cheapest, least lossy
   operation is never tried (Claude Code trims tool results *before* any summarization).
5. **No recovery path.** Superseded rows stay in the DB but nothing can reach them: no UI
   to view folded turns, no tool for the model to re-read a detail the summary dropped.
   ("File system as context" / restorable compression — never applied to Relay's own DB.)
6. **Freeform summary format.** No schema, so quality depends on the model's mood, and
   the prompt asks for "bullet-like prose" — no guarantee decisions/files/next-steps
   survive.

### 1.2 Cloud models — nothing at all

Verified end-to-end (the module docstring's "API providers are out of scope" is literal):

- **No pre-send accounting.** History from `list_active_chat_messages` maps straight to
  the wire (`commands.rs:1729-1755`, `providers.rs:251-255` / `:296-300`). No token
  estimate, no window knowledge, no truncation, no compaction.
- **Overflow is terminal and raw.** Provider 400 → `Err("HTTP 400: …")`
  (`streaming.rs:165-176`) → `chat:error` with `code: None` (`mod.rs:732-746`) → one-line
  banner showing the provider's raw text (e.g. "prompt is too long: N tokens > M maximum").
  No error classification (`prompt is too long` / `context_length_exceeded` /
  `exceed_context_size_error` are never matched), no retry, no compact-and-retry, no
  "start new chat" affordance. Partially streamed text is persisted by the frontend as an
  orphan message.
- **The meter is fiction for most cloud models.** Flat `API_CONTEXT_WINDOW = 500_000`
  for every non-local model id (`src/lib/contextWindow.ts:25, 60-78`) — a 200k-window
  Claude shows ~40% when actually full, so the 0.7/0.9 warn/crit levels
  (`ContextMeter.tsx:55-56`) can never fire before a real overflow. OpenRouter's live
  `context_length` is display-only and never reaches the send path. "Used" is the *last*
  turn's `input_tokens` (one turn stale; nothing while composing). The hover breakdown is
  hardcoded fake proportions (15% system / 70% messages / 10% tools / 5% meta,
  `ContextMeter.tsx:163-177`). At 100%: color change only, no action.
- **No cache-awareness.** Full history is re-sent every turn (fine for prefix caching in
  principle — append-only from the DB), but the system prompt embeds a skills-catalog dir
  scan (`prompts.rs::available_skills_segment()`) that can change mid-session, and nothing
  positions `cache_control` breakpoints deliberately.

### 1.3 Harnesses — delegated, blind, and a truncate-only primer

Architecture (`agent_sessions.rs`): Relay persists user + assistant rows to its DB, but
per turn sends **one content string** into a persistent CLI process (claude_code
stream-json with `--resume`; opencode HTTP/SSE; kimi per-turn process; ACP = no resume at
all). Context lives inside the CLI's own session.

**What exists:**
- **Context primer** (`agent_sessions.rs:577-682`): fires only when there's no CLI
  session id (first harness turn, mid-chat engine switch, ACP respawn). Replays active
  DB rows into a `[Context handoff]` preamble — **truncate-only**: 24,000-char total
  budget (~6k tokens), 4,000 chars/message, `<think>`/`<tool>` blocks stripped, oldest
  turns silently dropped, never summarized. Tool results — which is where files-read,
  commands-run, and edits actually live — are display-only and never replayed, so the new
  engine doesn't know what was actually done beyond what reply prose mentions.
- **Nothing else.** No `/compact` passthrough (zero matches in the codebase), no
  auto-compact detection in the stream, no harness observability. Claude Code's own
  auto-compact/microcompact happen silently; the only signal Relay gets is that the next
  turn's `input_tokens` drops, moving the meter ring a turn later.
- **Hard ceiling:** `finish_turn` states it outright — "No context limit crosses this
  boundary; the CLI enforces its own window" (`agent_sessions.rs:4757-4760`).

**Gaps:**
1. A harness **without** its own auto-compact (e.g. a remapped `ANTHROPIC_BASE_URL`
   backend, which `harness_config.rs:99-138` explicitly supports) hard-fails at its
   window with a generic `chat:error`.
2. **Resume-failure gap:** if a persisted `--resume` id is stale/expired, the respawn
   path retries the same id and never re-primes — fresh CLI session, blank context,
   despite full DB history existing.
3. The 24k-char primer is the *only* continuity for ACP agents (no resume at all), and
   it's ~6k tokens of raw tail with a 4k-char-per-message clip.
4. The flat 500k meter lie applies (a 200k harness model shows ~40% when full).

---

## 2. How the best systems do it (research survey)

### 2.1 The taxonomy — SELECT vs GEN vs hybrid (arXiv 2608.01326)

- **SELECT** keeps a subset (message truncation, tool-result pruning, Aider's repo map,
  LLMLingua). **GEN** produces a novel summary (Codex, Gemini CLI). **Hybrid** stacks
  selection first with a summarization fallback — what Claude Code and OpenCode do.
- Theory result: some tasks force selection to need Θ(log n) *more* summary budget than
  generation — but generation compounds error across repeated compactions, and Anthropic's
  production compaction endpoint scored ~0.5 error (≈ random) on a set-membership
  benchmark at a ~14-kbit budget, vs ~⅓ error for an optimal Bloom filter and 0.02 for no
  compaction. **Lessons: budget matters enormously; prefer eviction (SELECT) over
  summarization (GEN) when possible; keep raw data re-readable; treat the summary as
  lossy and verify.**
- Codex itself warns "long threads and multiple compactions can cause the model to be
  less accurate."

### 2.2 Claude Code — the ordered ladder (the industry benchmark)

1. **Trim oversized tool results** first (biggest consumers, cheapest to cut).
2. **Snipping** of long content.
3. **Microcompact**: clear old tool calls/results, replace with metadata placeholders;
   reported to use Anthropic's `cache_edits` so the cached prefix survives. Preserves
   conversation + user instructions verbatim.
4. **Auto-compact** at ~95% of window (threshold lowered over time to protect headroom):
   full structured summary + fresh context, then continue with the summary plus the most
   recently accessed files. The summary prompt is **structured** — primary request &
   intent, key technical concepts, files & code sections, errors & fixes, problem
   solving, all user messages, pending tasks, current work, next step.
5. **Manual `/compact`** (optionally with focus instructions) and session-memory
   compaction slot into the same ordered pipeline.

Known failure modes are instructive: users report summaries losing work detail and
microcompact silently clearing MCP results they still needed — the community answer is
"evict, don't summarize; keep summaries structured; make evicted data re-readable."

### 2.3 Anthropic API — server-side primitives Relay can call today

- **Context editing** (`clear_tool_uses_20250919`): clears old tool results server-side
  when triggered (input-token threshold or tool-pair count), keeps the newest N pairs,
  `exclude_tools`, placeholder text; pairs with `clear_thinking_20251015` and the memory
  tool. Anthropic reports **29% agent improvement from editing alone, 39% with memory**.
- **Compaction beta** (`compact_20260112`): server-side summarize when input tokens hit a
  trigger (default 150k, min 50k). Claude writes a `compaction` block; the API drops
  everything before it on subsequent requests; client passes the block back.
  `pause_after_compaction` lets you preserve recent verbatim turns before continuing.
  **Cache guidance**: put a `cache_control` breakpoint at the end of the system prompt so
  compaction never invalidates the system-prompt cache, and another on the compaction
  block.
- **Engineering guidance** (effective-context-engineering): compact *before* quality
  degrades (context rot starts well before the hard limit); tune the summary prompt for
  **recall first, precision second**; tool-result clearing is the lightest-touch
  compaction; structured note-taking (memory tool / NOTES.md) beats re-reading history.

### 2.4 OpenAI Codex — compaction as a first-class endpoint

Evolution: manual `/compact` (summarize via the API with custom instructions) →
automatic at `auto_compact_limit` → dedicated **`/responses/compact`** endpoint returning
replacement items, including an opaque `encrypted_content` compaction item that preserves
the model's latent understanding of the original conversation. Note: this endpoint is
Responses-API-only — Relay's chat path is Chat Completions, so cloud compaction must be
app-side (or adopt Responses for compaction parity).

### 2.5 Gemini CLI — compress early

Threshold-triggered auto-compress at a configurable fraction of the window (default
~**70%**) — deliberately *earlier* than Claude Code's ~95%, protecting quality headroom —
plus manual `/compress`. Known-bug lesson: the compression call itself must respect
output-token limits or it 400s (their issue #7578) — Relay's local path already learned
the same lesson via its truncation fix.

### 2.6 Manus — practitioner principles for agent context

- **KV-cache hit rate is the #1 production metric** (10× cost delta). Keep the prefix
  stable, make context **append-only** (never rewrite history in place), insert explicit
  cache breakpoints.
- **Compression must be restorable**: drop a page's content only if the URL remains;
  drop a document only if its path remains. The file system (for Relay: the DB) is the
  ultimate context — "unlimited in size, persistent by nature, directly operable."
- **Recitation**: continuously rewrite a todo/goal at the end of context to combat lost-
  in-the-middle drift.
- **Keep failures in context** — erasing errors removes evidence.
- Mask tools rather than removing them (removal breaks cache + confuses the model).

### 2.7 Synthesis — the emerging best practice

1. **A ladder, cheapest-first**: trim/evict tool results → microcompact old results →
   structured summarization near the limit → emergency truncation. Never jump straight
   to summarization.
2. **Structured summary schema** with recall-first wording (Claude Code's 9 sections is
   the de-facto template).
3. **Trigger early enough** (quality degrades before the hard limit; Gemini uses 70%,
   Claude Code ~95%, Anthropic API default 150k/200k tokens) — but eviction delays the
   expensive step.
4. **Restorability everywhere**: every eviction keeps a pointer; summaries link to raw
   rows; the agent can re-read what was dropped.
5. **Cache-awareness**: append-only history, stable system prompt, breakpoint placement,
   prefer server-side/surgical edits that preserve the cached prefix.
6. **Avoid summary-of-summary compounding** when the raw data is still available.
7. **Observability**: compaction is a visible event with its own UX, not a silent side
   effect.

---

## 3. Redesign proposal

### 3.0 Goals

- One context-management engine, three frontends (local / cloud / harness), consistent UX.
- Compaction ladder cheapest-first; cache-aware; restorable; structured summaries.
- Compaction quality protected by triggering early (target zone ~0.70–0.80 of window)
  and by keeping raw data re-readable.

### 3.1 A shared context engine (new `src-tauri/src/chat/context_mgr.rs`)

Extract from the LocalGguf-only hook into a provider-agnostic engine:

- **Model window registry** (replaces the flat 500k): bundled JSON of per-model windows
  (Anthropic 200k-class, OpenAI families, known GGUF families, harness models) +
  OpenRouter live values, used by *both* the meter and the send path. One number per
  model, shown and enforced.
- **Token accounting**: cheap estimator (chars/4, per-model calibration constants) for
  pre-send checks; authoritative `input_tokens` from each response (already captured)
  as the post-turn truth; Anthropic `/v1/messages/count_tokens` where available.
- **The compaction ladder** (evaluated per turn, before send):
  - **L0 — pass**: under budget → send unchanged.
  - **L1 — tool-result eviction**: replace old tool outputs with
    `[evicted: <tool>, ~N tokens; ref <db_row_id>]` placeholders (keep the last K
    verbatim). On Anthropic prefer the server-side `clear_tool_uses` context editing so
    the cached prefix survives; locally this is a DB-content rewrite at compaction time.
  - **L2 — structured summarization**: summarize the aged-out span into a fixed schema
    (below) with a recall-first prompt; pin recent turns verbatim (as today); persist the
    `[compacted context]` row as today.
  - **L3 — emergency truncation**: drop oldest turns behind a marker rather than eat a
    400.
- **Structured summary schema** (the Claude Code 9-section template, adapted):
  primary request & intent / key decisions & concepts / files & code touched /
  errors & fixes / user messages (verbatim-ish) / pending tasks / current work / next
  step / pointers (paths, URLs, row ids). Same schema and prompt on all three paths so
  quality and UX are comparable.
- **Restorability**: summary row stores `superseded_ids` (it already does implicitly via
  `mark_superseded`); add a **context recovery** affordance — click the compacted marker
  → see folded turns; optionally a `read_history` tool so the model itself can re-read a
  folded turn (Manus's restorable-compression principle applied to Relay's DB).
- **Anti-compounding**: Relay keeps every superseded row. Default re-compaction still
  merges (cheap), but add a periodic **rebuild-from-raw** (re-summarize all folded raw
  rows instead of the prior summary text) to reset accumulated loss.

### 3.2 Cloud path

1. **Pre-send check**: estimate tokens (system + history + tool schema + response
   headroom) against the registry window; trigger the ladder at ~0.75 (configurable,
   mirroring the local knob).
2. **Summarizer call**: reuse the active provider's request machinery in non-streaming
   mode (optionally a cheaper model if configured) — there is no "same sidecar" to call,
   but the summarization prompt/schema are shared.
3. **Anthropic-native options**: pass the `context_management` beta
   (`clear_tool_uses` + optionally `compact_20260112`) for server-side, cache-preserving
   management; place `cache_control` at end-of-system-prompt (fixes the skills-catalog
   cache-buster too — make `available_skills_segment()` stable per session).
4. **Overflow classification + recovery**: match known overflow error shapes to a
   `context_overflow` code; on overflow auto-run the ladder once and retry, else surface
   "Compact & retry" / "Start new chat" affordances instead of a raw banner.
5. **Honest meter**: per-model window, composer-live estimate (not last-turn stale),
   real system/messages/tools breakdown replacing the fabricated 15/70/10/5, and a
   **Compact now** button at warn/crit instead of color-only.

### 3.3 Harness path

1. **Observability**: parse harness stream events for compaction signals (Claude Code
   auto-compact/microcompact notices) → emit `chat:status context_compacted` + a marker
   row, same UX as local.
2. **Passthrough**: expose `/compact` (and `/microcompact` where supported) in the
   composer for harness sessions; Relay forwards the command and refreshes the meter from
   the next turn's usage.
3. **Honest meter for harnesses**: resolve the harness's actual model (already tracked
   via `agent.actual_model.*`) against the registry instead of flat 500k; where a harness
   reports context-remaining (Claude Code does), use it.
4. **Primer upgrade**: replace the 24k-char truncate with (a) a structured summary of the
   older history produced by the shared engine (cloud summarizer call), (b) pinned recent
   turns verbatim, (c) an **artifact list** — files created/modified and commands run,
   harvested from DB tool rows — with paths so the new engine can re-read them. Raise the
   budget; the summary compresses better than raw truncation ever did.
5. **Resume-gap fix**: when a respawn with a persisted resume id fails with a
   session-not-found error, drop the id, rebuild via the (upgraded) primer instead of
   failing or continuing blank.
6. **Harnesses without native auto-compact**: use Relay's own meter; at threshold offer
   "Summarize & restart session" (structured summary → new CLI session via the primer).

### 3.4 Local path (keep the engine, fix the quality)

1. L1 eviction before summarization (local tool outputs become placeholders).
2. Structured schema + recall-first prompt (shared with cloud); raise `max_tokens`
   1024 → ~2048.
3. **Chunked map-reduce summarization** when the aged-out head exceeds the summarizer's
   input budget — replace the silent char-based truncation with sequential chunk
   summaries merged into one, so nothing is silently dropped.
4. Optional **summarizer override** setting: point compaction at a stronger local model
   or a cloud key while the session keeps running on the small model.
5. Rebuild-from-raw option (§3.1) to reset compounding loss; context-recovery UI for
   superseded rows.

### 3.5 Settings & UX consolidation

- One compaction settings section (enabled / threshold / pinned exchanges / summarizer
  preference) applying across paths where meaningful; migrate the two local-only knobs.
- Unified `[compacted context]` marker for all three paths with the "Compacted N → M
  tokens" notice and click-through to folded turns.

### 3.6 Phased rollout

| Phase | Scope | Why first |
|---|---|---|
| **P0 — honesty** | Window registry + honest meter (all paths) + overflow error classification | No behavior change; every later phase depends on real numbers; kills the 500k fiction |
| **P1 — cloud compaction** | Pre-send count, threshold trigger, structured summarize via provider, compact-and-retry on overflow | Cloud is the largest gap (currently nothing) |
| **P2 — shared engine** | Extract the ladder; L1 eviction everywhere; structured schema; recovery UI | Turns three stories into one code path |
| **P3 — harness** | Observability, `/compact` passthrough, primer upgrade, resume-gap fix | Biggest UX gap; builds on the shared engine |
| **P4 — local quality** | Map-reduce summarize, summarizer override, rebuild-from-raw | Polish on the path that already works |

Testing: keep the existing `compaction.rs` unit tests; add golden tests for the ladder
ordering, window registry resolution, overflow classification, and primer generation;
extend `compactionSettings.test.ts` for the unified settings.

---

## 4. Implementation status (2026-09-02)

All five phases are implemented and green: **614 Rust tests + 513 TS tests passing,
`tsc` clean, `vite build` clean.**

### P0 — honesty ✅
- `src-tauri/src/chat/context_windows.rs` + `src/lib/contextWindow.ts`: per-model window
  registry (mirrored tables, `claude` 200k, `gpt-5` 400k, `gpt-4.1` 1M, `gemini` 1M, …,
  most-specific-first substring matching, 500k fallback). OpenRouter's live figure is no
  longer capped at 500k.
- `src-tauri/src/chat/error_class.rs`: overflow classification (`context_overflow` code)
  wired into both error emitters (built-in chat `mod.rs`, harness `emit_error`); the
  frontend store carries `errorCode` and the banner renders actionable copy.
- `count_context_tokens` / `count_context_breakdown` extended to cloud + harness sessions
  (char-based estimator, session's own provider for the system prompt, harness actual-model
  window resolution); `useContextMeter` polls every provider; ChatView takes
  max(live estimate, provider-counted last turn); ContextMeter drops the fabricated
  15/70/10/5 breakdown. Fingerprint cache prevents skills-dir rescan on every 2s poll.

### P1 — cloud compaction ✅
- `src-tauri/src/chat/cloud_compact.rs`: config (`chat.cloud.*`), request-size estimation,
  `run_cloud_compaction` (split → provider summarizer → rewritten history),
  `persist_summary_row`.
- Send path section 6c: threshold-triggered pre-send compaction with the same status UX
  as local. `mod.rs` `compact_and_retry`: on a classified overflow error the turn is
  force-compacted and retried ONCE (cloud providers only).
- `chat_compact_now` command + "Compact now" button in the meter panel (non-local sessions).

### P2 — shared engine + recovery ✅
- Structured 9-section summary schema (recall-first, errors kept) in
  `compaction.rs::summarization_system_prompt` — used by BOTH the local sidecar path and
  the cloud provider path.
- `trim_entry_content`: per-message head+tail cap on the summarizer input.
  **Deviation from the doc**: the ladder's L1 "tool-result eviction" exists as this
  per-message trimming instead — Relay's built-in history never re-sends tool results
  across turns (they are display-only `<tool>` blocks, stripped on rebuild), so there is
  nothing to evict; the real hazard is a single oversized turn, which the cap handles.
- Recovery UI: `list_compacted_messages` command + "show folded turns" disclosure on the
  `[compacted context]` marker (session-scoped, think/tool blocks stripped).
- Settings: one "Compaction (advanced)" panel covers local + cloud engines; cloud settings
  mirror the Rust loader (defaults + clamps pinned by `compactionSettings.test.ts`).

### P3 — harness ✅
- Observability: the claude_code stream reader handles `system` events — a
  `compact_boundary` persists a marker row and emits `context_compacted` (meter refresh;
  the summary text itself stays inside the CLI session).
- `/compact` + `/microcompact` in the composer slash menu for harness sessions, forwarded
  verbatim to the CLI (the command pill composes as literal `/compact …` text).
- Primer upgrade: budget raised to 32k chars tail / 6k per message; `primer_tail_and_head`
  splits history at exactly the point the tail budget runs out, and `build_primer_summary`
  (awaited in the async send command, never blocking the spawn path) cloud-summarizes the
  dropped head via `resolve_cloud_summarizer` — falls back to the legacy truncate-only
  primer when no provider is configured or the call fails.
- Resume-gap fix: a claude_code process that dies with ZERO turn activity while a resume
  id was in play is treated as a stale `--resume` — the id is dropped and the next send
  replays the primer instead of resuming blank. Cancels excluded; a false positive costs
  one primer replay.
- Harness meter honesty came free with P0 (registry + actual-model resolution + live poll).

### P4 — local quality ✅
- Map-reduce summarization: entries that don't fit the summarizer budget are chunked,
  map-summarized (512-token partials), and folded into the main call — nothing is silently
  dropped anymore; summary output cap raised 1024 → 2048.
- Summarizer override: `chat.local_gguf.compaction_summarizer = "cloud"` routes summaries
  through the first configured cloud provider (`resolve_cloud_summarizer`, shared with the
  primer); sidecar fallback when unconfigured. Honored by "Compact now" too.
- Rebuild-from-raw (`chat.local_gguf.compaction_rebuild_from_raw`, default on): when the
  trigger fires and a prior summary exists, its raw source rows are re-fed into the
  compaction input (only then — a below-threshold or passthrough turn never sees them), so
  each new summary is re-derived from the ORIGINAL turns. Injected for the cloud path's
  compaction input as well.

### Known limitations
- The harness primer summary requires a configured cloud provider; with none, engine
  switches keep the (raised) truncate-only primer.
- Claude Code's internal summary text is not exposed by the CLI, so harness compact
  markers record the boundary, not the content.
- Cloud compaction triggers on an ESTIMATED request size (~4 chars/token); the
  overflow-retry path covers estimator error.

---

## Sources

- [Context Compaction Theory (arXiv 2608.01326)](https://arxiv.org/html/2608.01326v1)
- [Effective context engineering for AI agents — Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Context editing — Claude Docs](https://docs.claude.com/en/docs/build-with-claude/context-editing)
- [Compaction — Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Unrolling the Codex agent loop — OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [GPT-5 Codex prompting guide — OpenAI Cookbook](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)
- [A Look at Context Engineering in Gemini CLI — Paul Datta](https://aipositive.substack.com/p/a-look-at-context-engineering-in)
- [Gemini CLI settings / compression](https://geminicli.com/docs/cli/settings/)
- [Context Engineering for AI Agents — Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- [What is Micro-Compact in Claude Code — ClaudeLog](https://www.claudelog.com/faqs/what-is-micro-compact/)
- [Managing context on the Claude Developer Platform (HN discussion)](https://news.ycombinator.com/item?id=45479006)
