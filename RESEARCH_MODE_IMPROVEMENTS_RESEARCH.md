# Research Mode — System Map & Improvement Research

**Date:** 2026-09-03 · **Method:** full read of the research-system source tree + live web research (3 parallel tracks: deep-research architectures, search/extraction infrastructure, verification/citation/eval). Sources cited throughout; consolidated source list at the end.

---

## 1. What exists today (system map)

Relay's research mode is a single-agent, prompt-scaffolded Plan → Execute → Synthesize loop with a SQLite evidence ledger. Component by component:

| Layer | Implementation | Where |
|---|---|---|
| Trigger | Keyword heuristic (`is_research_request`) — trigger phrases ("research the…", "compare", "deep dive on") vs single-fact guards ("capital of", "ceo of"); `/research` prefix forces it | `src-tauri/src/chat/prompts.rs:365` |
| Scaffolding | `RESEARCH_SEGMENT`: plan 3–5 sub-questions → search broad (2–3 `web_search`), triage with `browser_read summary_only`, record verbatim excerpts via `add_source_note` → synthesize from `get_source_ledger`, flag contradictions, emit `generate_file` report with `[n]` citations + Sources section. Local-model addendum tightens budgets | `src-tauri/src/chat/prompts.rs:417–449` |
| Search | `web_search` = keyless scrape of DDG HTML SERP + DDG Instant Answer API + Wikipedia API, merged, de-duped, top 8 shown | `src-tauri/src/chat/tools/search.rs:338` |
| Reading (silent) | `fetch_url` = reqwest GET, regex tag-stripper (`html_to_text`), 12 KB truncation, 1 MiB cap, SSRF guards | `src-tauri/src/chat/tools/search.rs:134` |
| Reading (visible) | `browser_read` = live webview + vendored Mozilla Readability bridge → structured markdown; modes `full` / `summary_only` (~1500 chars triage) / `section`; `failureReason` taxonomy (paywalled/login_required/extraction_failed/blocked); consent-banner dismissal; lazy-load scroll | `src-tauri/src/browser.rs:2213`, spec at `src-tauri/src/chat/tools/specs.rs:383` |
| Ledger | `chat_source_notes` SQLite table (url, title, fact, verbatim excerpt, unavailable, created_at); `add_source_note` (INSERT OR IGNORE dedupe) / `get_source_ledger` / `reset_source_ledger`; capped at most-recent 50 | `src-tauri/src/db/source_ledger.rs` |
| Budget | Research turns get 96 tool iterations vs 45 normal | `src-tauri/src/chat/streaming.rs:31–37` |
| Citations (render) | Frontend parses the LAST `## Sources`-style section, rewrites `[1]`/`[1,2]`/`(1,2)` markers into interactive chips (hover preview, click opens pane) — only when every number resolves | `src/lib/chatCitations.ts` |
| Subagents | `task` tool spawns one read-only subagent with its own model turn and the full read-side research stack; returns final text as tool result | `src-tauri/src/chat/tools/mod.rs:96,589` |

This is a genuinely solid foundation — the verbatim-excerpt ledger is architecturally the same idea as WebWeaver's "evidence bank" (arXiv 2509.13312), a 2025 SOTA mechanism. The gaps are in what's *checked*, *fetched*, and *how wide* the loop can go.

---

## 2. Gap analysis (code-grounded)

### G1. The search foundation is fragile — and one leg is already dead
- **Live check during this research: the DDG Instant Answer API (`api.duckduckgo.com/?format=json`) returns HTTP 200 with all-empty payloads.** It's unmaintained legacy — a third of the current "three sources" contributes nothing but latency and a mask over engine failures (the "all backends failed" error only fires when *all three* error; the dead API never errors, so real DDG outages can surface as "No results found").
- The DDG HTML endpoint needs a rotating `vqd` token and is in a documented cat-and-mouse cycle (403s, captchas). One engine's breakage = research mode's discovery breaks.
- No other engines, no freshness/recency filtering, no domain filters, fixed top-8, no caching (every research run re-hits the SERP), no query history (the "2–3 searches, never repeat" rule is prompt-only — nothing enforces or even records it).

### G2. `fetch_url` extraction quality is far below the webview path
- Regex tag-stripping (`remove_blocks` + `strip_html`) loses main-content structure, tables, and list semantics; the webview Readability bridge is only available when a pane is open. Journal-grade extraction is a solved problem in Rust.
- 12 KB truncation silently drops most of a long report; no PDF support at all (a large share of primary sources — papers, filings, whitepapers — are PDFs).

### G3. Trust is prompt-hoped, not mechanically verified
- Citation numbers are model-self-reported. The frontend chips render whatever the model wrote. Published audits: generative search engines had **51.5% citation recall / 74.5% precision** as early as 2023 (Liu et al.); the 2025 Tow Center study found **>60% wrong-attribution failure across 8 engines**; best-case deep-research tools reach only ~80% citation precision. The ledger *makes verification mechanical* — but nothing verifies.
- No check that `[n]` numbers resolve to actual ledger rows; no check that a claim has any overlap with its cited excerpt; unused-ledger-row and orphan-citation counts unknown.

### G4. Orchestration is one-shot and static
- No scope/clarify phase: the plan is invented silently from a one-line user request. Gemini (editable plan) and LangChain open_deep_research (clarify → brief) both put a human approval gate before the spend.
- No evidence-sufficiency check: "stop once you have 2–3 corroborating notes" is prompt guidance with no structured exit criterion. Premature stopping is the #1 failure mode targeted by 2026 enterprise research work (arXiv 2604.24978).
- The `task` subagent tool exists but research mode never fans out — Anthropic measured **+90.2%** for orchestrator-worker over single-agent on research evals.

### G5. The ledger under-documents its evidence
- No fetch/access date, no publisher name, no per-note stance (supports/contradicts) or confidence. Temporal conflicts (stale-vs-fresh sources) are a first-class error class in the literature (ConflictBank) and the ledger can't currently date-weight.
- Contradiction handling is one prompt sentence. Google's CONFLICTS paper (arXiv 2506.08500) shows **explicit-conflict prompting alone significantly improves** conflict behavior — cheap win not yet applied.

### G6. No measurement
- No internal eval harness. Prompt/model changes to research mode ship with zero citation-precision/recall trend data, despite deterministic metrics being computable from the ledger for free.

---

## 3. What the leaders do (digest)

- **OpenAI Deep Research**: single end-to-end RL-trained agent; 5–30 min runs; citations drawn only from pages actually browsed. BrowseComp 51.5%.
- **Gemini Deep Research**: **user-editable research plan before execution**; planner decides which sub-questions run concurrently; live reasoning dashboard; synthesis pass "identifies themes and inconsistencies"; ~1M context + **RAG over collected research** for follow-ups.
- **Anthropic Claude Research**: **orchestrator–worker** — lead agent spawns 3–5 parallel subagents with distinct questions; effort tiers scale subagent count/tool budget; subagents return **compressed findings**, not transcripts; phase summaries to external memory; a **dedicated CitationAgent post-pass** verifies every claim maps to sentence-level evidence; LLM-judge rubric evals caught an SEO-farm source bias. Multi-agent beat single-agent by **90.2%** on their research eval; parallelism cut wall-clock up to 90%.
- **Perplexity Deep Research**: iterative search-read-refine within a **hard ~25-search budget**, 2–4 minute reports; 93.9% SimpleQA — fact precision as the product.
- **Grok DeepSearch vs DeeperSearch**: search count as a product tier; Grok 4 Heavy = best-of-N parallel attempts merged.
- **Open source**: **LangChain open_deep_research** (clarify → brief → supervisor → compress at subagent boundary); **HF open-deep-research** (single agent, 2 tools, 55% GAIA — code actions batched steps ≈ 30% fewer tokens; minimal tools win); **GPT Researcher** (breadth × depth knobs, per-subquestion workers); **STORM** (perspective-guided question asking — a pure prompt technique); **WebWeaver** (evidence bank + iteratively revised outline bank — the published version of Relay's ledger); **Search-o1** (per-source distillation before reasoning — the recipe for small local models); **"Don't Stop Early"** (evidence-aware termination checklist; never dump raw observations between stages).
- **Local-model heuristics (Jan.ai)**: "5–10 searches minimum, reward MORE searches; every query unique" — directly applicable to the GGUF tier.

---

## 4. Recommendations (prioritized, code-anchored)

### P0 — Harden the foundation (days, no new keys, keyless preserved)

**R1. Multi-engine keyless search aggregator** (`search.rs`)
- Delete the dead DDG Instant Answer call. Port the `ddgs` pattern: DDG-lite HTML as one *optional* engine + **Mojeek HTML** (independent index, scrape-tolerant, explicitly AI-use-friendly, allows ≤1 h caching) + Wikipedia API. Merge with per-engine error tolerance and surface per-engine health (`"engines: mojeek ok, ddg rate-limited"`) so "no results" vs "engine down" stays honest — the existing `errors`/`sources_tried` plumbing already models this.
- Record queries in a `research_queries` table; inject "already-run queries" into context; hard-nudge on exact repeats. Add `recency` and `exclude_domains` params to the tool schema and translate them per-engine (Mojeek supports `t=`/site minus via `-site:`).

**R2. Real extraction in `fetch_url`** (`search.rs` / new module)
- Replace the regex stripper with **`dom_smoothie`** (Readability.js port on html5ever; best-in-class in a 13-crate Rust benchmark) + markdown serialization. Keep the webview bridge for JS-heavy failures.
- Add **`r.jina.ai` as the keyless fallback**: on 403/blocked/JS-wall, retry via Jina Reader (no key: 20 RPM; outputs LLM-clean markdown; **parses PDFs server-side for free**). One-line upgrade that un-breaks hard sites and adds PDF support.
- Raise the truncation cap for `mode=full`-grade reads (e.g., 30–40 KB) — with R5's distillation the model consumes summaries, not raw dumps.

**R3. SQLite caches** (`db/`)
- `search_cache(providers+query+filters → payload, fetched_at)` TTL 6–24 h; `page_cache(canonical_url, content_hash, markdown, fetched_at)` TTL 7–30 days. Canonical-URL normalization (strip `utm_*`/fragments, host lowercase) with a UNIQUE index = free cross-engine dedup. Note: **Brave's terms prohibit result storage** without a storage plan — cache URL/metadata only for Brave-sourced results (relevant once R8 lands).

**R4. Citation-integrity lint** (Rust, zero LLM cost, ~1 day)
- Post-synthesis pass over the generated report + ledger: (a) every `[n]` must resolve to a ledger row — flag/strip orphans; (b) count unused ledger rows; (c) count uncited sentences (the citation-recall denominator); (d) **verbatim-overlap check**: normalized token overlap between each claim sentence and its cited excerpt — low overlap = weak attribution (BBC found 13% of "quotes" absent from the cited article; this catches that deterministically).
- Emit a `citation_report` row; surface weak/orphan chips in the existing `chatCitations.ts` pipeline (amber styling).

**R5. Explicit-conflict prompting + ledger date/publisher** (prompt + schema)
- Add the CONFLICTS-paper pattern to the Synthesize segment: identify conflicting note pairs before writing; prefer newer/more authoritative; where genuinely ambiguous, state both with dates. Require hedging on weakly supported claims (only ~11% of wrong citations get hedged today per Tow).
- Add `published_at`/`accessed_at` + `publisher` columns to `chat_source_notes`; `browser_read` metadata already extracts publish date/byline — plumb it through `add_source_note`.

### P1 — Research quality (1–2 weeks)

**R6. Scope phase: clarify → brief → editable plan** (prompts + one tool)
- On research trigger, one extra model turn emits ≤3 clarifying questions *or* (when unneeded) a research brief + 3–5 sub-question plan; render as an approval card (reuse the existing plan-approval UI — `present_plan` pattern) with one-click "looks good" / editable. Store the brief as ledger row #0. This is the single highest-leverage HITL pattern across Gemini/LangChain/OpenAI.

**R7. Evidence-sufficiency exit check** (one small tool)
- `check_sufficiency`: before `generate_file`, the model must call it with per-subquestion status (supported by ≥2 independent domains / opposing view found / key numbers captured / open questions). Fail → the tool returns "not sufficient: …" and the loop continues (bounded by the existing 96-iteration cap). The checklist doubles as the report's "What's still unknown" section.

**R8. BYO-key search providers behind an adapter trait** (Settings + `search.rs`)
- **Serper** as default paid engine ($1/1k, 2,500 free queries, Google SERP + News + Scholar).
- **Tavily** as the agentic option (`topic=news`, `time_range`, `include/exclude_domains`, `include_raw_content:"markdown"` — features that map 1:1 onto research mode; $8–16/1k).
- **Brave** for independent-index diversity ($5 credits/mo; mind the storage term).
- Keep keyless as the default/fallback path; per-provider health surfaced in the tool result.
- **Avoid:** Google CSE (discontinued — migrate by 2027-01-01, new engines capped at 50 domains), Bing API (retired 2025-08-11), Kagi ($25/1k), Firecrawl (redundant with webview + Tavily at this scale).

**R9. Per-source distillation for local models** (Search-o1 pattern)
- When `ModelClass::Local`: after each read, the ledger note stores a one-sentence distilled claim + stance, and later turns receive the claim *index*, not full excerpts (extend `get_source_ledger` with a `compact=true` mode). Mirrors Anthropic's "dependency-controlled context" — never propagate raw observations between phases.

**R10. Async post-hoc citation-precision sampler** (~2–3 days)
- After the report is delivered, extract atomic claims (Claimify-style: select → disambiguate → decompose), sample ≤15, and ask the model "does ledger excerpt X support claim Y? yes/partial/no" in one batched call. Produces real per-run citation precision/recall; upgrade chips green/amber/red live. This operationalizes ALCE/AIS with the ledger as the identified source — no fine-tuning, one extra call per run, fully asynchronous so the user never waits.

### P2 — Differentiators

**R11. Deep tier: parallel worker fan-out.** Effort tiers (Quick / Standard / Deep) in the UI. Deep = the main agent fans out 2–4 `task` subagents, one per sub-question cluster (or per STORM perspective), each prompted to return *compressed findings + source list, never raw pages*; lead synthesizes from returned summaries + its own ledger. This is Anthropic's exact architecture using the existing `task` tool.

**R12. Research state file + phase compaction.** Rolling `research_state` (plan, per-subquestion status, findings digest, open gaps) persisted in the ledger DB; on long runs, Rust-side replaces consumed tool outputs with the state digest — Anthropic's compaction recipe, and what makes 96 iterations survivable at 32k context.

**R13. RARR-style repair pass.** Claims failing R10 get one revision call: rewrite/delete or re-cite the correct ledger row (the ledger is the corpus — no re-search needed). "Edited by verifier" annotation keeps it honest.

**R14. Internal eval harness (~1 week).** Seed 20–50 questions (BrowseComp-style verifiable needles, FRAMES-style multi-hop, ~10 "evergreen" refreshed quarterly); run headlessly via the existing loop; grade with (a) the deterministic R4 metrics, (b) a DRACO-style weighted binary rubric with negative "unsupported claim" criteria. Track citation precision/recall per backend model (frontier vs GGUF). This turns every prompt change into a measured decision.

**R15. Trust UX package.** In evidence order: live source list during Execute (publisher names — trust transfers from cited brands); chip states green/amber/red from R4/R10; "Sources disagree" side-by-side conflict cards; a per-run quality footer ("14/15 sampled claims verified against sources") instead of implying perfection; skippable clarifying questions; follow-up Q&A constrained to the same ledger (Gemini's RAG-over-research pattern).

**R16. Later/optional.** Best-of-N "Heavy" runs merged by a comparison pass; local `bge-reranker-v2-m3` reranking via llama.cpp `--rerank`; Exa for semantic queries; yt-dlp shelling for YouTube transcripts; MiniCheck-class local verifier (770M, GPT-4-level grounding checks at 400× less cost) so verification works offline for GGUF users.

---

## 5. Suggested sequencing

1. **Week 1 (P0):** R1 + R2 + R3 (foundation) → R4 + R5 (trust lint + conflicts). Ship visible improvement immediately: better sources, fewer 403 dead-ends, honest chips.
2. **Weeks 2–3 (P1):** R6 scope phase → R7 sufficiency → R8 providers → R9/R10.
3. **Then (P2):** R11 Deep tier and R14 evals in parallel; R12/R13/R15 as follow-ups.

The theme: **the ledger is the moat** — competitors' citation failures are mostly *unverifiable* because they never captured evidence; Relay's ledger makes every verification (R4, R10, R13) deterministic or one cheap call away. Invest in evidence capture + verification before orchestration complexity.

---

## 6. Key sources

**Architectures:** [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · [OpenAI Deep Research](https://openai.com/index/introducing-deep-research/) · [Gemini Deep Research](https://gemini.google/overview/deep-research/) · [Perplexity Deep Research](https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research) · [xAI Grok 4](https://x.ai/news/grok-4) · [LangChain open deep research](https://blog.langchain.com/open-deep-research/) · [HF open-deep-research](https://huggingface.co/blog/open-deep-research) · [GPT Researcher](https://github.com/assafelovic/gpt-researcher) · [STORM](https://arxiv.org/abs/2402.14207) · [WebWeaver](https://arxiv.org/abs/2509.13312) · [Search-o1](https://arxiv.org/abs/2501.05366) · [Don't Stop Early](https://arxiv.org/html/2604.24978v1) · [Tongyi DeepResearch](https://arxiv.org/abs/2510.24701) · [Kimi-Researcher](https://moonshotai.github.io/Kimi-Researcher/) · [Deep Research survey](https://arxiv.org/abs/2506.12594) · [Jan local deep research](https://www.jan.ai/post/deepresearch)

**Search/extraction infra:** [Tavily](https://www.tavily.com/pricing) · [Serper](https://serper.dev/) · [Brave API](https://brave.com/search/api/) · [Exa](https://exa.ai/pricing) · [Bing retirement](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement) · [Google CSE discontinuation](https://programmablesearchengine.googleblog.com/2026/01/updates-to-our-web-search-products.html) · [ddgs multi-engine aggregator](https://github.com/deedy5/ddgs) · [Mojeek API](https://www.mojeek.com/services/search/web-search-api/) · [Jina Reader](https://jina.ai/reader) · [dom_smoothie](https://github.com/niklak/dom_smoothie) + [13-crate benchmark](https://emschwartz.me/comparing-13-rust-crates-for-extracting-text-from-html/) · [bge-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3)

**Verification/eval/UX:** [ALCE citation metrics](https://aclanthology.org/2023.emnlp-main.398/) · [AIS attribution](https://arxiv.org/abs/2112.12870) · [RARR](https://arxiv.org/abs/2210.08726) · [Claimify](https://arxiv.org/abs/2502.10855) · [MiniCheck](https://arxiv.org/abs/2404.10774) · [Generative-search verifiability baseline](https://arxiv.org/abs/2304.09848) · [Tow Center citation audit](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php) · [EBU/BBC news integrity](https://www.ebu.ch/news/2025/10/ai-s-systemic-distortion-of-news-is-consistent-across-languages-and-territories-international-study-by-public-service-broadcaste) · [ConflictBank](https://arxiv.org/abs/2408.12076) · [CONFLICTS/explicit-conflict prompting](https://arxiv.org/abs/2506.08500) · [DRACO benchmark](https://www.perplexity.ai/hub/blog/evaluating-deep-research-performance-in-the-wild-with-the-draco-benchmark) · [DeepResearch Bench](https://arxiv.org/abs/2506.11763) · [BrowseComp](https://arxiv.org/abs/2504.12516) · [Mind2Web 2](https://arxiv.org/abs/2506.21506)
