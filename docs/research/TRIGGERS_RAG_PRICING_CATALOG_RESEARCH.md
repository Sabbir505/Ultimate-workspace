# Triggers beyond cron · Hybrid RAG · Live model catalog · Pricing & cache savings

> **Status:** research complete, not yet built · **Date:** 2026-09-19
> **Scope:** §5 improvement items 6 (automation triggers), 7 (hybrid RAG), 13 (live harness catalog),
> 14 (pricing refresh + cache savings) from `FEATURE_MAP_AND_GAP_ANALYSIS_2026-09-19.md`.
> All internal claims verified in code on this date. Headline corrections to the original gap analysis are
> flagged per part — two of the four items turned out to be partially shipped already.

---

## Part A — Automation triggers beyond cron (webhook / file-watch / git / email)

### A.1 What exists today (verified)

- **Scheduler**: one 30s tokio tick (`automations.rs::start`, wired at `lib.rs:459`); due-math is a single
  function `due_automations` → `next_fire(schedule, last_run_at ?? created_at)` using the **`cron` crate**
  (5-field minute-first cron, local time; missed windows catch up exactly once). Overlap guards: in-process
  `RUNNING` set, cross-process PID+lock-file, 6h staleness cap, depth-capped recursion.
- **Schema**: `automations.schedule` is ONE cron string — there is no trigger-type column.
  `automation_runs.source` is free-text (`scheduled`/`manual`) — new trigger sources need **no DDL**, only
  `RunSource` variants.
- **Run-while-closed**: `relay-automation run-due` is spawned every minute by Task Scheduler; it links
  `relay_lib` and calls the SAME `due_automations` (no duplicated math) but is a **short-lived process** —
  no listeners, no watchers, exits after the pass.
- **Outbound notify exists**: run-finalize posts a webhook (`automations.webhookUrl`, 5s timeout) and
  failure-emails via the **Gmail connector REST API** (token refresh proven headless) — but nothing inbound.
- **Listener precedents**: OAuth loopback (one-shot TCP, fixed vendor ports), mobile relay WS (loopback +
  saved port + pairing-token HMAC), browser-MCP WS (ephemeral port + token-first-message auth). All are
  **loopback-only** — external senders (GitHub, email push) cannot reach any of them without a tunnel.
- **Watcher infra**: `git_watcher.rs` = per-project `notify::RecommendedWatcher`, 300ms debounce / 2s burst
  cap, emits `project:fs-changed` — but **discards event paths** (`mpsc<()>`). The vault watcher is a second
  debounce idiom that *keeps* paths. Watchers exist only for registered projects/worktrees.
- **No git-event source anywhere**: `git.rs` is deliberate poll-on-demand; nothing watches HEAD.

### A.2 Design per trigger

**Schema first (all triggers)**: add `trigger_type TEXT DEFAULT 'cron'` + `trigger_config TEXT` (JSON) +
`last_trigger_state TEXT` (dedupe state: last SHA, last IMAP UID/historyId, last fs-fire) alongside
`schedule` (migration after `migrate_automations_origin`). Extend `RunSource` with `webhook|fs|git|email`.
`automation_next_fire` and the UI must degrade gracefully for non-cron rows (today an unparsable cron
renders "schedule error — will not fire", which a naive migration would turn into *silently disabled*
automations — the #1 trap).

**(a) Inbound webhook** — new resident loopback HTTP server templated on `browser_mcp::serve` (ephemeral
port published via handshake file) or the mobile relay (saved port). Per-automation secret URL
`/trigger/<automation_id>/<token>` (token in keychain, QR/copy in the Automations form) — **auth is
mandatory: an unauthenticated webhook that launches a full-auto agent turn is remote code execution.**
Dispatch = `launch_run(source=Webhook)`. App-open only by design (loopback); document that run-while-closed
webhooks need a tunnel — do NOT auto-expose via Tailscale without a separate explicit opt-in.
Name it `automations.trigger.*` — `automations.webhookUrl` is taken (outbound).

**(b) File-watch** — extend the watcher-install path: when installing watchers for projects/worktrees, also
install for automations whose `trigger_config.path` canonicalizes to a not-yet-watched dir (the vault
watcher pattern — keep paths); on debounce fire, evaluate matching trigger rows → `launch_run(source=Fsa)`.
Overlap guards already prevent pileups; add a per-automation minimum re-fire interval in
`last_trigger_state` so a churning folder doesn't run the agent continuously. Teardown on automation
delete/disable must mirror `git_watcher::uninstall`'s **dual canonical-path key** lesson (`\\?\C:\…`).

**(c) Git-event** — cheapest correct shape: on the fs-changed debounce path (or in the 30s tick for
registered repos), run `git rev-parse HEAD` and compare to `last_trigger_state` before firing (commit /
branch-change triggers). **Push/PR-open triggers need polling** the GitHub connector (budget-timer pattern)
or an external webhook (needs tunnel — see (a)). Bonus symmetry: because HEAD-SHA comparison is pure DB+git,
**the run-while-closed sidecar could evaluate commit triggers inside its one-minute lifetime** — the only
non-cron trigger run-while-closed can support without becoming resident.

**(d) Email** — recommend **Gmail-via-REST polling first** (historyId compare using the existing connector;
`ensure_valid_access_token_with_db` already works headless; poll on the 30s tick or a 60s budget-timer-style
loop, `gmail.readonly` scope). Generic IMAP/IDLE needs a new IMAP crate + keychain creds (`secrets.rs`
exists) — defer until someone actually asks; local-first polling beats idle-push for a desktop app, and
push would need a tunnel anyway.

**Cross-cutting gotcha (must decide before building)**: `next_fire` computes from `last_run_at`, so ANY
non-tick run (run-now today; webhook/fs/git tomorrow) **delays the next scheduled slot**. Event-triggered
runs should advance a separate `last_event_run_at`, not `last_run_at`.

**Effort**: schema + RunSource + webhook listener **M (3–4d)**; file-watch **S–M (2d)**; git SHA triggers
**S–M (2d, +sidecar support 1d)**; Gmail triggers **M (2–3d)**; UI (trigger-type control in AutomationForm
+ next-fire degradation) **M**. Sensible ship order: schema → webhook → file-watch → git → gmail.

---

## Part B — Hybrid RAG (RRF fusion · reranker · contextual enrichment)

### B.1 What exists today (verified)

Pipeline: `KnowledgePanel` → `docs_index.rs` (walk → mtime/size diff → `chunk_text` → embed batches of 16
via llama-server `--embedding` sidecar → f32 blobs in `doc_chunks`). Search: `db::search_chunks` = brute
cosine over **every** enabled chunk in Rust; **there is no FTS leg for docs at all** (FTS5 exists only for
chat messages, memories, vault). **Chunks are bare `Vec<String>`** — no struct, no heading trail, no
offsets, no per-chunk metadata; path lives per-file. Embedding **dimension is stored nowhere** — a model
swap leaves silently-skipped zombie chunks. `pdf-extract` is a dependency but PDFs are *not* indexed for
corpora (attachments only). `search_docs` requires the embedding sidecar to be up (`local_docs` caps gate).

### B.2 Design

**(a) RRF hybrid (FTS5 + vectors)** — new `doc_chunks_fts` (fts5 external-content on `doc_chunks.content`
+ triggers, mirroring `chat_messages_fts`) + backfill for existing corpora; a safe MATCH builder already
exists three times (`db/memory.rs`, `db/chat.rs`, vault). The RRF math itself (k=60 reciprocal-rank fusion
of the two ranked lists) is new — memory's "hybrid" is a weighted heuristic, NOT RRF; don't copy it. New
`db::search_chunks_hybrid` runs both legs and fuses; `run_search_docs_tool` + `compute_docs_retrieval`
switch to it. **Side benefit: keyword-only search keeps working with the sidecar down** — revisit the
`local_docs` caps gate (`chat/mod.rs:474`) which currently hides `search_docs` entirely when the embedder
is off. Keep brute cosine (bounded at 50k chunks/corpus); sqlite-vec remains unnecessary at this scale.

**(b) Reranker (top-50 → top-8) — architecture correction from research: use llama-server's native
`/v1/rerank`, not ONNX.** llama-server exposes `POST /v1/rerank` with `--reranking --pooling rank`, and
bge-reranker-v2-m3 ships as GGUF (Q8_0 ≈ 600MB). That means the reranker is a **sibling of the existing
embedding sidecar** (`LocalModelRegistry::start_reranker`, same GPU-first/CPU-fallback/health-poll pattern)
+ a small `/rerank` HTTP client + download entry in the existing Model Market — **zero new Rust ML
dependencies** (no `ort`, no `tokenizers`, no ONNX export pain; community ONNX exports of this model have
known performance problems anyway). Stage: fuse → take top-50 → one `/rerank` call (query + 50 chunk
texts, 512-token cap per doc — the model was fine-tuned at 1024) → top-8 → existing caps. Run in
`spawn_blocking` **outside** the DB mutex. Pin a specific tested GGUF + llama build via the existing
`pinned_zip`/`build_updates` pattern — cross-backend score bugs have been reported (llama.cpp vs vLLM,
Oct 2025), so pin and smoke-test, and keep a "reranker off" toggle (default off until eval'd).
Optional: Qwen3-Reranker GGUFs as a higher-quality tier later.

**(c) Contextual enrichment (path + headings)** — `chunk_text` grows to return `(offset, heading_trail)`
(tracking `#`/`##` lines while slicing; markdown-only heuristic; non-md files get path-only). Store
`heading TEXT` (+ offsets) as new `doc_chunks` columns (ALTER-pattern migration). **Embed raw content;
render the enrichment prefix at query/format time** from metadata — embedding the prefix too double-pays
tokens per chunk and pollutes vector space; displaying it at query time is what actually helps the model
situate a chunk. **Enrichment requires a forced corpus re-index** — mtime/size diff will never pick up
chunk-shape changes on its own; version-stamp corpora (`enrichment_version` column or settings marker) and
re-index once. Image surrogates get path-only enrichment in `compose_surrogate`. Consumers that render
chunk content (`dispatch.rs`, `chat/mod.rs`) must not double-print prefixes.

**(d) Eval harness (prerequisite, cheap)** — copy `memory/eval.rs`'s fixture pattern: synthetic corpora
with hand-authored embeddings + gold chunk ids, gate recall@8 (and post-rerank precision@8) offline in
`cargo test`. Needs the FTS table to exist to exercise RRF meaningfully. Without this gate, "is the
reranker helping" is vibes.

**Effort**: (a) hybrid+RRF **M (3–4d)** · (d) eval fixtures **S (1d, do first)** · (c) enrichment+reindex
**M (2–3d)** · (b) reranker sidecar **M (3–4d, after eval exists)**. Ship order: (a) → (d) → (c) → (b).

---

## Part C — Live harness model catalog (replace the static fallback)

### C.1 What exists today (verified) — and a scope correction

The static catalog (`harnessModels.ts`, 4 Claude + 3 Kimi rows, deliberately empty for the other four
harnesses) is **already 90% retired**: `list_harness_models` (30s TTL, `spawn_blocking`, empty results
never cached) feeds the AgentModelPicker and ChatView live, and static rows are appended **only** for ids
live discovery missed. The picker already has an empty-state "Retry discovery" button; ChatView already
keeps the stale list on failure without poisoning its cache. The live backend covers all six harnesses
(config-file parsing for claude/kimi/opencode/pi; pure live `--list-models`/`models --json` for
omp/commandcode), including default-model + effort discovery.

So the remaining work is genuinely small:
1. Delete the static fallback import + merge lines in `AgentModelPicker.tsx:240` and `ChatView.tsx:232`
   (keep the on-failure stale list); delete `harnessModels.ts` and its `harnessModelLabels` consumers.
   Residual risk removed: a stale static row the CLI rejects.
2. Add a "↻ Refresh list from CLI" affordance beside the retry (bypass the 30s TTL — one IPC param).
3. Badge provenance: `HarnessModelInfo.source` ("config"|"cli"|"builtin") already comes back — surface it.
4. **Free pricing data going to waste**: omp's `models --json` dump carries per-model `cost` objects that
   `parse_omp_models_json` drops — keep them, and optionally extend `HarnessModelInfo` with resolved rates
   (via `pricing::resolve_rate`) so the picker can show cost-per-million chips.
5. Fix the stale TS union in `ipc/artifacts.ts:624` (`"config" | "builtin"` omits the `"cli"` source the
   backend actually emits).
6. The TODO's remaining ambition (probing the CLI handshake itself for claude/kimi instead of config
   files) is a `harness_config.rs` extension, not a frontend task — track separately or close the TODO as
   satisfied-by-live-discovery.

**Effort: S (1–2d)** for 1–5.

---

## Part D — Pricing auto-refresh + family-aware cache rates + cache-savings hero

### D.1 What exists today (verified) — two scope corrections

1. **The uniform cache-read multiplier is ALREADY fixed.** `pricing.rs::cache_multiplier` is family-aware:
   `gpt-*`/`o1`/`o3`/`o4` = 0.5×, everything else = 0.1× (Anthropic-correct), with a sourced comment.
   Remaining work is *coverage* (DeepSeek/Gemini/GPT-5.x-family drift), not de-uniformizing.
2. **Cache savings is ALREADY computed end-to-end**: `pricing::cache_savings()` accumulates per-row into
   `CostQuality.cacheSavingsUsd`, and `StatsRow` already renders a "Cache savings" stat. `CostHero` shows
   only raw cost — **surfacing savings in the hero is a presentational change** to `CostHero.tsx` (it
   already receives the full rollups object). Add: savings headline ("$X saved by prompt caching"), and an
   effective-input-rate framing (savings ÷ cached tokens vs list input rate). Caveat to caption: rows priced
   by provider-reported cost still estimate the counterfactual from the rate table; cache-creation tokens
   contribute zero savings by design.
3. Also found: `pty/mod.rs::price_for` is a fossil computing prices nobody reads (dead `pricing_estimated_usd`
   column) — delete while touching this area; and the three-layer rate resolution (compiled table →
   `price.<model>.*` setting overrides → observed-from-provider rates) already exists with automatic rollup
   invalidation when any override changes.

### D.2 Design: auto-refreshed pricing table

**Source**: the [LiteLLM `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
(+ its published JSON schema) — the de-facto community registry, updated within a day of new models, with
**exactly the fields Relay needs**: `input_cost_per_token`, `output_cost_per_token`,
`cache_read_input_token_cost`, `cache_creation_input_token_cost`, `max_input_tokens`, `supports_prompt_caching`
(per-token costs × 1e6 = Relay's per-Mtok rates). Explicit cache-read rates from the source would demote
`cache_multiplier` to fallback-only — the right end state. Secondary source: OpenRouter's `/api/v1/models`
(`pricing.prompt`/`pricing.completion`, USD-per-token strings) for OpenRouter-keyed users and for the
picker's price chips (Part C.4).

**Mechanism**: fetch daily (GitHub raw URL) in a task beside the budget timer (`lib.rs:438` pattern);
extract only entries matching models Relay knows (canonical keys from logs + configured providers) or store
a filtered subset; persist as one JSON blob + `fetched_at` under a new settings namespace; read it as a new
layer inside `read_rate_overrides` (between compiled table and user overrides — **user overrides must stay
on top**); staleness/absence falls back to the compiled table. Rollup invalidation is already automatic (the
freshness marker hashes the override map). Manual "Refresh prices now" in Settings → Version control / Data;
indicate table age in the Cost dashboard footer.

**Effort**: hero **S (0.5–1d)** · refresh pipeline **M (2–3d)** · fossil cleanup + stale union fixes **S**.

---

## Combined sequencing

| Order | Item | Effort | Why this order |
|---|---|---|---|
| 1 | C: live catalog swap + omp cost + source badges | S | Pure deletion + small UI; kills a TODO |
| 2 | D: cache-savings hero (+ fossil cleanup) | S | Data already computed; one component |
| 3 | D: pricing auto-refresh (LiteLLM) | M | Makes every historical + future price correct |
| 4 | A: trigger schema + webhook listener | M | Schema unblocks the rest; webhook is highest demand |
| 5 | B: docs FTS + RRF (+ keyword-only when sidecar down) | M | Biggest quality win; no new deps |
| 6 | B: eval fixtures → enrichment → reranker sidecar | S+M+M | Eval gate before quality claims |
| 7 | A: file-watch → git → Gmail triggers | S–M each | One trigger per release cadence |

## Sources (external)

- [LiteLLM model_prices_and_context_window.json](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) · [schema](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.schema.json) · [prompt-caching cost fields](https://docs.litellm.ai/docs/completion/prompt_caching)
- [OpenRouter models API pricing fields](https://openrouter.ai) (`pricing.prompt`/`pricing.completion`, USD/token)
- [bge-reranker-v2-m3 (BAAI)](https://huggingface.co) — 568M params, ~1.1GB FP16, fine-tuned at 1024 tokens; [ONNX-version discussion](https://huggingface.co); ONNX-runtime performance caveats reported (Jan 2025) — avoided entirely by the GGUF route
- llama-server `/v1/rerank` (`--reranking --pooling rank`) with bge-reranker-v2-m3 GGUF (Q8_0 ≈ 600MB); cross-backend score-consistency bug reports (Oct 2025) → pin model+build
- Internal (2026-09-19): `automations.rs`, `automation_task.rs`, `bin/relay_automation.rs`, `git_watcher.rs`, `vault/mod.rs`, `connectors/{oauth,gmail_api}.rs`, `mobile/relay.rs`, `browser_mcp.rs`, `docs_index.rs`, `chat/docs.rs`, `db/docs.rs`, `db/mod.rs`, `chat/local_models.rs`, `chat/dispatch.rs`, `harness_config.rs`, `commands/agent_cmds.rs`, `harness_adapters/{mod,pricing}.rs`, `cost_v2.rs`, `commands/budget.rs`, `CostHero.tsx`, `StatsRow.tsx`, `AgentModelPicker.tsx`, `harnessModels.ts`, `memory/{retrieve,eval}.rs`
