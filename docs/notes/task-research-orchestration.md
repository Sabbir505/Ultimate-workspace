# Task: Research Orchestration — Source Ledger, Plan/Execute/Synthesize Prompting

## Context

Companion task `task-browser-extraction-quality.md` upgrades what a single page-read returns. This task is the orchestration layer on top: how the model plans a multi-source research task, tracks what it's learned with proper attribution, handles conflicting sources honestly, and produces a verified, cited final answer — rather than one continuous improvised search-click-read-summarize loop. This is primarily prompt/scaffolding work plus one small new tool, not a large new subsystem.

## What to build

### 1. Source ledger tool (new tool in `chat/tools.rs`)

```
add_source_note(url: string, title: string, fact: string, excerpt: string) -> void
get_source_ledger() -> LedgerEntry[]
```

- `add_source_note` is called by the model as it reads each source, once per distinct fact/claim worth keeping (not once per page — a single page read may produce several ledger entries, or none if it wasn't useful).
- Ledger persists for the duration of the research task (session-scoped in-memory state tied to the chat session, or a lightweight DB table if you want it inspectable/exportable later — a table is preferable since it also gives you a debugging/audit trail for free, consistent with how the filesystem activity log works elsewhere in this app).
- `get_source_ledger` lets the model re-read its own accumulated notes during synthesis, rather than relying on scrolling back through conversation history to remember what it found on page 4.
- Surface the ledger to the user too: when a research task completes, the final Markdown artifact should include a **Sources** section generated from ledger entries (title, url, one-line note per source) — reuse the existing artifact-rendering path, this is just a Markdown template, not new UI infrastructure.

### 2. Plan → Execute → Synthesize prompt scaffolding (core prompt addition, `chat/mod.rs`)

Add explicit staged guidance to the core prompt (or a conditionally-loaded "research mode" prompt segment, triggered the same way skills are conditionally loaded — matching the existing skill-loading pattern rather than inventing a new triggering mechanism) covering three phases:

**Plan phase** — before any browsing:
- Decompose the research question into 2-5 concrete sub-questions.
- Identify what a genuinely diverse set of sources would look like for this question (don't let all sources trace back to one original source).
- State the plan briefly before executing it (both so the user can see it, and because stating a plan measurably improves follow-through vs. improvising turn to turn).

**Execute phase** — per sub-question:
- Search broad before drilling deep: 2-3 searches to map the landscape before committing to reading any single source in full.
- Use `browser_read`'s `summary_only` mode (from the companion task) to triage candidates before spending a `full` read on any of them.
- Call `add_source_note` for each fact worth keeping, with the actual excerpt it came from — not a paraphrase at this stage, paraphrasing happens at synthesis, not extraction.
- If a source is paywalled/login-required/extraction-failed (structured failure from the companion task), note it as an unavailable source rather than silently skipping — this should surface in the final Sources section as "consulted, unavailable" so the user knows a gap exists rather than assuming coverage was complete.

**Synthesize phase** — after research, before final answer:
- Read back through `get_source_ledger()`, not conversation memory, when writing the summary.
- **Explicitly flag contradictions**: if ledger entries disagree on a factual claim, say so in the output rather than silently picking one version or averaging them into a false consensus.
- **Verification pass**: before finalizing, check the draft summary against the ledger — every non-obvious factual claim in the draft should trace to a ledger entry. Cut or hedge anything that doesn't.
- Every claim in the final output should be attributable to a specific source in the Sources section — this is the practical, in-app version of "don't use a statistic unless the source is clear."

### 3. Context-budget guidance in the prompt

- Explicit instruction: prefer `summary_only`/`section` reads over `full` reads by default; only escalate to `full` when the summary suggests the page is genuinely central to a sub-question.
- Cap guidance: for a typical research task, aim for reading in full no more than ~5-8 sources — if the task seems to need more, that's a signal the sub-questions were scoped too broadly and should be split further, not a reason to silently read 20 pages and blow the context budget.
- This matters more once local/smaller models are in play (per the earlier core-prompt STRICT-addendum design) — flag in the prompt that budget discipline should be more aggressive for `ModelClass::Local`.

### 4. Research-mode trigger

- Detect research-shaped requests ("research X," "find out about Y," "what's the current state of Z") and load the Plan/Execute/Synthesize scaffolding for that turn — same conditional-loading mechanism as skills, not always-resident in every Chat tab conversation (a simple "what's 2+2" turn shouldn't carry this scaffolding).
- Simple single-fact lookups ("what's the capital of France," "who is the current CEO of X") should NOT trigger the full scaffolding — one `web_search` call and a direct answer is correct for these; reserve the staged approach for genuinely multi-source questions. Worth a brief heuristic/example set in the prompt distinguishing the two cases, since over-triggering the full research flow on simple questions would make the Chat tab feel slow and over-engineered for everyday use.

## Acceptance criteria

- [ ] `add_source_note`/`get_source_ledger` implemented and callable through the existing tool loop for all supported providers.
- [ ] A multi-source research request produces: a stated plan before browsing, evidence of broad-before-deep search behavior, ledger entries with real excerpts (not paraphrases) accumulated during execution, and a final answer that reads back from the ledger rather than conversation memory.
- [ ] Final research output renders as a Markdown artifact with a Sources section derived from ledger entries, including any "consulted, unavailable" entries for paywalled/failed sources.
- [ ] A test case with genuinely conflicting sources (construct or find a real example) results in the output explicitly flagging the disagreement, not silently picking one side.
- [ ] Simple single-fact questions do NOT trigger the full plan/execute/synthesize scaffolding — verify response latency/behavior stays fast and direct for these.
- [ ] Regression check: existing `web_search`/`fetch_url` based Q&A (non-research-mode) still works as before.

## Out of scope for this task

- Multi-agent/sub-agent orchestration (separate model instances per sub-question) — this task uses staged prompting within a single agent loop, not a true orchestrator/worker architecture. Note as a possible future upgrade if research quality on very broad questions proves insufficient with the single-loop approach, but don't build it now.
- Social posting or any write-capable browser actions — explicitly excluded per the earlier conversation; this task is read/research only.

## Process reminder

Per PRD §13: this task is prompt-engineering-heavy — budget real iteration time against actual research questions (not just the acceptance-criteria checklist) since prompt scaffolding quality is judged by output quality, not just "did the tool calls fire in the right order." Log example research transcripts (good and bad) in `BUILD_LOG.md` as you iterate, since these are the most useful record of what the scaffolding is actually getting right or wrong — more useful here than a pass/fail test count.
