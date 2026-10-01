# Project Wiki / Repo Knowledge — Auto-Generated, Agent-Readable Project Documentation

**Date:** 2026-10-01
**Status:** Research / proposal (no implementation yet)
**Scope:** The §6 Tier-2 #15 proposal — auto-generate and maintain a searchable project knowledge
base from git history + code + RAG (the Devin Wiki pattern), surfaced as an agent tool and a
sidebar tab.
**Builds on:** `docs/research/TRIGGERS_RAG_PRICING_CATALOG_RESEARCH.md` (RAG redesign — implemented:
RRF + reranker + enrichment), the shipped AGENTS.md support (§4.2.10), and the docs-watcher
incremental indexing (§5.25).

---

## 1. TL;DR — Recommendation

**Build the wiki as owned markdown with claim-level evidence versioning, generated inside Relay by
the existing subagent machinery, and surface it to BOTH humans and every agent Relay hosts.**

The 2026 landscape validated the feature category (Google shipped CodeWiki and open-sourced the
framework in the same quarter) but also split it into two camps, and Relay sits in the second one:

| Camp | Who | Model | Wiki lives | Kept fresh by |
|---|---|---|---|---|
| **Hosted regeneration** | DeepWiki (Cognition), codewiki.google | Cloud, always re-generated | Vendor-hosted site | Rebuild after every commit |
| **Owned agent memory** | OpenWiki (LangChain) | The user's own coding agent | Plain markdown **in the user's repo**, claims + evidence sidecars | Claim-evidence recheck on update; no-op skip |

Relay should ship the owned-markdown model with OpenWiki's best idea — **Grounded Claims**: every
material fact on a page points at versioned source evidence (`path + line range + blob SHA`), and
staleness is *detected by diffing evidence versions*, not guessed. That converts the wiki from a
docs generator (which rots) into a knowledge index with a drift alarm.

| Phase | What | Why now | Effort |
|---|---|---|---|
| **A** | **Wiki v1** — storage + one-shot build (repo map → outline → pages via read-only subagents, Mermaid diagrams) + a Wiki overlay tab | Every building block exists: subagents, mermaid render/export, progress-event pattern, git plumbing | M (~1–2 weeks) |
| **B** | **Freshness** — HEAD-SHA + per-page evidence sets, update pass (section-level patches, no-op skip), git-trigger + packaged "wiki refresh" automation template | Git HEAD-change trigger already exists (`automation_triggers.rs:305`); merge-base diffing exists (`git.rs:439`) | M (~1 week) |
| **C** | **Agent surfacing** — `search_wiki` / `read_wiki_page` tools + auto-index the wiki as a RAG corpus + layer the index page into harness bundles | Tool wiring checklist is mechanical (registry→specs→dispatch→bridge→permissions); wiki pages are markdown, so the existing enriched embedder works as-is | S–M (~3–5 days) |
| **D** | **Verification & polish** — groundedness pass (cite-or-cut), Mermaid validate/degrade/repair, eval fixture, Vault export, optional in-repo `.relay/wiki/` mode | The 2026 lesson: verification is the differentiator, not generation | M–L |

Phase C is the differentiator none of the competitors can copy quickly: **the wiki reaches all six
harness CLIs through the `relay-tools` bridge**, not just Relay's built-in chat. DeepWiki serves
humans; OpenWiki serves one agent per repo; Relay's wiki is shared memory for every agent the user
runs — built-in, Claude Code, Kimi, OpenCode, Pi, OMP, CommandCode — plus phone and automations.

---

## 2. What exists today (code-verified 2026-10-01)

No wiki/repo-map/project-summary feature exists (grep over `src-tauri/src` and `src` confirms), but
the adjacent infrastructure is unusually complete:

| Capability | State | Where |
|---|---|---|
| Repo → searchable corpus | **Exists** — docs RAG pipeline indexes source code already (`TEXT_EXTENSIONS` includes .ts/.rs/.py…), incremental mtime/size walk, schema-versioned re-chunk | `src-tauri/src/chat/docs.rs:12-46`, `db/docs.rs` |
| Hybrid search | **Exists** — FTS5 + vector legs fused by RRF (K=60), optional local reranker; `search_docs` tool gated on `ToolCaps.local_docs` | `db/docs.rs:513-560`, `chat/dispatch.rs:2893`, `chat/tools/mod.rs:358` |
| Contextual enrichment | **Exists** — embed input is `path · heading + content` (schema v2); a wiki page is ideal input for this shape | `chat/docs.rs:225` |
| Background job pattern | **Exists** — registry + cancel oneshot + throttled progress events (`docs:index:progress`), the exact shape a `wiki:build:progress` job should copy | `src-tauri/src/docs_index.rs:28,103,444,578` |
| Commit detection | **Exists** — git HEAD-SHA compare on the 30 s tick AND the run-due sidecar (run-while-closed) | `src-tauri/src/automation_triggers.rs:68,305-351` |
| Changed-file diffing | **Exists** — `get_branch_changed_files` merge-base math; `get_git_log` for history pages | `src-tauri/src/git.rs:439-485,957` |
| Subagent writer workforce | **Exists** — `Task` read-only subagents (100-round cap), declarative subagents with per-definition model + `worktree_policy` | `chat/dispatch.rs:843,1475`, `session_fabric/mod.rs:2105,2265` |
| Diagram rendering + export | **Exists** — Mermaid 11.17 + ELK, per-theme palettes, 1–4× PNG export | `src/components/chat/MermaidDiagram.tsx:82-107`, `ArtifactExportMenu.tsx:472` |
| Markdown knowledge base with wikilinks | **Exists (the Vault)** — note/tag CRUD, `[[wikilinks]]`/tags/headings/blocks parsed, `vault_fts` FTS5, FS watcher, hover previews, editor | `src-tauri/src/vault/mod.rs:180-769`, `vault/index.rs:81`, `src/components/vault/*` |
| Per-project instructions layering | **Exists** — AGENTS.md ancestor-walk + prompt layering (8k cap) + read/write tools; the wiki pointer block should live next to it | `src-tauri/src/agents_md.rs:21-89`, layering at `agent_sessions/bundle.rs:103`, `chat/commands/send.rs:1145-1147` |
| New-surface plumbing | **Exists** — `ActiveView` union + `isOverlayView` + `App.tsx` branch for a new overlay; Settings `NAV_SECTIONS` for config | `src/state/ui.ts:21-25`, `src/lib/viewKinds.ts:9`, `SettingsView.tsx:204-255` |
| Content firewall | **Exists** — deterministic injection scanner over injected blocks; wiki content layered into prompts should pass through it too | `src-tauri/src/prompt_firewall.rs` (§4.1.8) |
| Prompt-injection risk from repo files | **Managed** — repo content is untrusted input during generation; the same firewall rules apply to wiki-derived prompt blocks | `chat/permission.rs`, `prompt_firewall.rs` |

The triad framing: Relay already has **user memory** (extraction/consolidation), **session
summaries** (Session Mesh distillation, `db/session_fabric.rs:168`), and **corpus RAG** (raw file
chunks). The wiki is the missing fourth layer: **synthesized, per-repo, human-and-agent-readable
knowledge** — the only one of the four that reads like documentation.

---

## 3. The 2026 landscape

### 3.1 DeepWiki (Cognition) — the pattern-name source

Auto-generates a structured, navigable wiki for any GitHub repo at `deepwiki.com/<owner>/<repo>`;
under the hood it maintains a **persistent codebase index** that also powers Devin Search for
monorepo navigation. Hosted, public-repo-first, cloud-model. The gap doc's "(Devin Wiki pattern)"
refers to this. Relevance to Relay is the *shape* (overview → architecture → per-module pages,
diagrams, grounded Q&A), not the deployment model.

### 3.2 Google CodeWiki (codewiki.google) — the 2026 validation event

Shipped publicly Feb 2026 and **open-sourced** ([FSoft-AI4Code/CodeWiki], ACL 2026 Findings; paper
[arXiv 2510.24428]). The important findings from the paper:

- **Three-phase pipeline** (worth copying): (1) repository analysis — AST/LLM parsing builds a
  dependency graph and identifies high-level components; (2) documentation generation — agents
  write wiki pages from the dependency graph, scaling from thousands of LOC to 1M+; (3)
  **verification** — consistency/accuracy checks against the code, and docs are regenerated after
  every commit.
- **Three reported innovations**: hierarchical decomposition of the repo, recursive multi-agent
  generation with dynamic task delegation, multi-modal synthesis (architecture + class + sequence
  diagrams). Seven languages.
- **Measured quality**: 68.79% overall vs DeepWiki's 64.06% (+4.73) on their CodeWikiBench
  (LLM-judge rubrics), +10.47 on scripting languages — i.e., **even the best generator is ~2/3
  accurate**, which is the strongest argument for claim-level evidence and a verification pass
  rather than trusting generation.
- Positioning quote (Google): AI coding agents "make incorrect inferences when superficially
  scanning large codebases — living documentation helps both humans and agents." A Gemini CLI
  extension for private repos was announced (hosted regeneration reaching for the agent-memory
  camp).

### 3.3 OpenWiki (LangChain) — the design to beat for Relay's shape

MIT-licensed CLI (2026) that writes and maintains **agent documentation you own**, in-repo under
`openwiki/`. Its design principles map almost one-to-one onto Relay's values:

- **Grounded Claims**: every repo-page fact is tracked in `.claims/` sidecars pointing at
  versioned evidence (`repo://src/server.ts#L40-L82`). `openwiki --update` checks repository
  changes **and claim evidence versions** — if the evidence behind a claim changed or vanished,
  that page needs rework even if a planner wouldn't have picked it. This is drift *detection*,
  the thing the docs-as-code consensus says matters more than generation.
- **No-op detection**: clean repos skip all model work (no churn, no cost).
- **Consumption is retrieval, not RAG-by-default**: `openwiki_search` (ranked) and `openwiki_read`
  (section reads) as local, read-only, **model-free** MCP tools; described as "optional context,
  not a routine step at the start of every task."
- **Durability**: per-page job queue checkpointed to `.run.json`; page completion is a persistence
  boundary; parallel page workers (1–8); resumable.
- **Mermaid hygiene**: diagrams that fail validation degrade to text fences and are auto-repaired
  on a later run — never let a broken diagram poison the page.
- **AGENTS.md co-existence**: a managed `<!-- OPENWIKI:START/END -->` block; never touches
  user-authored instructions. (Relay's analog: the wiki pointer lives beside the AGENTS.md
  layering, in its own managed block.)
- **CI updates** open docs PRs — generated knowledge becomes reviewable like code.

### 3.4 DeepWiki-Open (AsyncFuncAI) — the DIY architecture reference

Open-source DeepWiki clone: repo clone → code analysis → structured wiki + Mermaid diagrams →
embedding index → RAG chat. Confirms the pipeline is reproducible with commodity parts (AdalFlow +
an embedder + an LLM); no proprietary magic.

### 3.5 Cross-cutting lessons (docs-as-code consensus + research)

- **Detection beats generation**: the hard problem is knowing *which* docs went stale, not writing
  more docs (Falconer docs-as-code guide; RepoDoc knowledge-graph traceability,
  [arXiv 2604.26523]).
- **Section-level patching preserves quality better than full rewrites** — full regenerations
  accumulate drift and destroy good content (Notion-sync writeups; matches OpenWiki's page-level
  jobs with claim-level rechecks).
- **Grounding + judge verification is now table stakes** for generated docs: CodeWiki ships a
  verification phase and still scores ~69%; unverified generation is a hallucination faucet.
- **Wikis for agents are a distinct reader**: agents want compact, link-dense, claim-checked
  markdown with stable anchors; humans want diagrams and narrative. Same store, two renderers.

### 3.6 What competitors-in-kind (desktop agent shells) ship

Nothing native. LM Studio/Ollama/Cherry Studio/Msty have no repo-knowledge layer; coding-agent
CLIs (Claude Code, Codex, Cursor) rely on instructions files + embedding indexes. The wiki lane is
occupied only by hosted services (DeepWiki/CodeWiki) and the OpenWiki CLI — **no desktop shell
bundles it**, which is exactly the §8 "defend these" pattern (native browser panes, GGUF market,
run-while-closed).

---

## 4. Design — mapped onto Relay

### 4.1 Storage: DB-backed markdown, not a repo write (default)

| Option | Pros | Cons |
|---|---|---|
| **SQLite pages (recommended default)** | Local-first, zero repo pollution, works for non-git folders, per-project scoping free, matches artifacts/memory/vault precedent | Not git-reviewable; needs export path |
| In-repo `.relay/wiki/*.md` | Git-versioned, PR-reviewable (OpenWiki pattern), survives DB resets | Writes to the user's repo uninvited; needs the exec/FS gate story; merge conflicts |

Recommendation: **DB is the source of truth; export is a first-class action** (to the Vault —
where wikilinks and the existing editor apply — or to `.relay/wiki/` for teams who want docs PRs,
Phase D). Pages are markdown with YAML front matter (`type`, `generated: {by, at}`, `verified`),
OpenWiki OKF-compatible so exported wikis interop with that ecosystem.

Tables (mirroring `doc_corpora`/`doc_chunks` conventions, self-migrating in `init_schema`):

- `wiki_projects` — one wiki per bound project root (path, HEAD sha at last build, schema version
  for re-build triggers — same trick as `DOCS_CHUNK_SCHEMA_VERSION`, `db/docs.rs:136`).
- `wiki_pages` — slug, title, kind (overview/architecture/module/glossary/history/how-to), body
  markdown, status (`fresh`/`stale`/`rebuilding`/`failed`), generated_at, generated_by (model id).
- `wiki_claims` — page_id, claim text, `evidence_path`, `line_start`, `line_end`, `blob_sha` (the
  OpenWiki `.claims/` sidecar, relational). This table is the freshness engine.
- `wiki_jobs` — durable job queue (page-level rows, status, attempts) so a crashed build resumes
  where it stopped (OpenWiki's persistence-boundary lesson; copy the `IndexRegistry` cancel-slot
  shape from `docs_index.rs:103`).

### 4.2 Generation pipeline (Phase A)

1. **Repo analysis** (no LLM): walk with the existing `SKIP_DIRS`/caps discipline
   (`chat/docs.rs:24,40-43`); build a repo map — tree with LOC/extension stats, top files by
   centrality (imports), README/AGENTS.md/docs inventory, `get_git_log` hotspots (the "git history"
   half of the original proposal: churn leaders, recent-change themes). CodeWiki's lesson: this
   phase is deterministic and cheap, and its quality caps everything downstream.
2. **Outline**: one LLM call (or a small subagent crew) turns the repo map into a page list —
   overview, architecture, one page per high-level module, glossary, "recent activity" — each with
   a bullet brief and the file set it may cite. Page cap default ~20 (configurable), mirroring the
   corpus chunk caps philosophy.
3. **Page generation**: per page, a read-only subagent (`Task`, `worktree_policy: never`) reads its
   brief's file set and writes markdown with Mermaid diagrams; every non-obvious factual sentence
   must carry an evidence annotation (file + line range) which the backend extracts into
   `wiki_claims` with `blob_sha` resolved at write time. Parallel page workers bounded like
   OpenWiki (1–4), each a persisted job row.
4. **Verification pass v1**: mechanical checks only — evidence paths exist, line ranges in bounds,
   Mermaid parses (see §4.6), no empty pages. LLM-judge groundedness lands in Phase D.

Model plumbing: the build model is the project/chat model picker, defaulting to the active chat
model — so a local GGUF can build the wiki (slow but free) exactly like memory extraction made its
model configurable. Cost preview before "Build": pages × estimated tokens, honoring the §4.4
advisory-budget display. Progress via `wiki:build:progress` (copy `IndexProgress` +
`docs:index:progress`, `docs_index.rs:28,75`).

### 4.3 Freshness (Phase B) — the part that makes it a wiki instead of a document

- **Triggers**: (a) manual "Update wiki" button; (b) the git HEAD-change trigger
  (`automation_triggers.rs:305`) driving a debounced update pass (NOT the 300 ms `git_watcher` —
  wiki updates must batch on commits, not keystrokes); (c) a packaged **"wiki refresh" automation
  template** (`automation_templates.rs` prefill pattern) — on Windows this runs **while the app is
  closed** via the Task Scheduler sidecar, which is a genuinely unique freshness story (the wiki
  updates itself overnight, free on a local model).
- **Update pass**: `git diff --name-status <wiki.head>..<HEAD>` → intersect with
  `wiki_claims.evidence_path` → pages needing rework get `stale` + are queued for **section-level
  patching** (regenerate the affected sections against current evidence, keep the rest). No
  changed claims → **no-op, zero model calls**. Deleted evidence → claim marked `vanished` → the
  sentence is cut or the page flagged for rewrite (never silently kept).
- **Interaction with checkpoints/pruning**: wiki state is independent of `refs/relay/checkpoints`;
  the wiki always describes the working tree HEAD, not a session's undo state.
- **Non-git folders**: no HEAD → updates are manual-only (and the button says so).

### 4.4 Agent surfacing (Phase C)

- **Tools**: `search_wiki` (FTS5 over `wiki_pages` bodies — no embeddings needed for v1; hybrid
  RRF over a wiki corpus is the later upgrade) and `read_wiki_page` (slug → markdown, section-
  addressable). Both read-only (`permission.rs` auto-run), gated by a new `ToolCaps.wiki` computed
  per turn like `local_docs` (`chat/tools/mod.rs:450`). Wiring follows the exhaustiveness-checked
  checklist: name consts (`chat/tools/mod.rs`) → specs (`chat/tools/specs.rs`) → dispatch arm →
  `ALLOWED_RELAY_TOOLS` (`mcp_tools_bridge.rs:27`) so **all six harness CLIs + ACP agents get the
  wiki through the relay-tools bridge**.
- **RAG integration**: the wiki is also indexed as an internal doc corpus (pages are markdown, so
  `enriched_embed_text`'s `path · heading + content` shape is exactly right) and auto-attached to
  chats in the project (`chat_documents`, `db/docs.rs:568-595`) — `search_docs` then covers wiki
  content for free, and per-turn auto-retrieval (`chat/mod.rs:544-552`) starts surfacing it.
- **Prompt layering**: only the **index page** (title list + one-line summaries, budget-capped like
  AGENTS.md's 8k) is layered into harness bundles and the built-in system prompt, inside a managed
  block adjacent to the AGENTS.md section (`agents_md.rs:59-89` pattern), passed through the
  prompt firewall. The wiki tells the agent *what exists*; the agent *pulls* pages on demand.
  This respects OpenWiki's "optional context, not a routine prefix" principle — the cheap index
  rides along, the expensive pages are retrieved.
- **Injection posture**: repo files can contain adversarial instructions; generation prompts treat
  file content as data, `wiki_claims` keep facts tied to evidence, and wiki-derived prompt blocks
  pass the deterministic firewall (`prompt_firewall.rs`) at layering time — the wiki must not
  become a prompt-injection amplifier with persistence.

### 4.5 Human surfacing (Phase A shell, Phase D polish)

- **Wiki overlay tab**: `ActiveView` variant + `isOverlayView` + `App.tsx` branch
  (`ui.ts:21-25`, `viewKinds.ts:9`); sidebar tree of pages by kind; per-page freshness badge
  (fresh/stale with the offending changed files); LazyMarkdown body + `MermaidDiagram` rendering;
  evidence annotations render as code links (jump to file/line — the DiffCard click-through
  pattern); `ArtifactExportMenu`-style PNG export for diagrams (1–4×, `:472`).
- **Page history**: prior page versions retained (bounded, like checkpoint pruning philosophy) so
  "what did the wiki say before this refactor" is answerable; diff view between versions.
- **Settings section**: build model, page cap, auto-update trigger on/off, export target
  (`NAV_SECTIONS` addition, deep-linkable like other panels).
- **Mobile**: read-only wiki surface is a natural post-v2 add (the pairing channel already mirrors
  costs/approvals); defer.

### 4.6 Verification & eval (Phase D)

- **Groundedness judge**: per page, an LLM pass scores each claim against its cited evidence
  (cite-or-cut); failing claims are removed or the page is flagged — CodeWiki's phase 3, scoped to
  claims instead of whole pages. Reuses the blind-LLM-judge machinery from the self-improving
  artifacts loop (§3.7).
- **Mermaid hygiene**: validate at generation (the frontend already parse-fails loudly; move a
  `mermaid.parse` check into the build pass); on failure degrade to a fenced block + queue repair
  on the next update pass (OpenWiki's degrade-and-repair).
- **Eval fixture**: a small golden repo in-tree with expected page coverage + claim verification
  assertions, gated in tests like `db/docs_eval.rs` — guards the pipeline against prompt/model
  drift.
- **Honest limits**: CodeWiki measures ~69% generation accuracy with cloud Gemini and a dedicated
  verification phase; Relay v1 should present the wiki as "generated, evidence-linked, may be
  wrong — check the linked source", never as ground truth. Badges, not promises.

---

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Hallucinated architecture reads as truth | Claim-level evidence + verification pass + "generated" badges; CodeWiki's ~69% is the calibration point |
| Staleness (the classic wiki death) | Claims + blob-SHA recheck makes staleness *computable*; no-op skip prevents churn; HEAD-triggered updates make freshness automatic |
| Cost/runaway builds | Page cap, per-page job rows, cost preview, advisory-budget integration, local-model option; update passes touch only dirty pages |
| Prompt injection with persistence (poisoned repo → poisoned wiki → every future session) | Generation treats file content as data; firewall scans wiki blocks at layering; claims pin facts to evidence so edits are auditable |
| Repo noise/monorepo scale | Reuse corpus `SKIP_DIRS`/caps; hierarchical outline; per-module pages keep any single page's read set bounded |
| Writes the user didn't ask for | DB-backed default; repo exports are explicit, opt-in, and clearly fenced (`.relay/wiki/` only in Phase D opt-in mode) |
| Duplication with AGENTS.md/Vault | Division of labor: AGENTS.md = user-authored instructions (wiki never rewrites it, managed blocks only); Vault = human-curated notes (wiki exports INTO it); wiki = generated knowledge |
| Windows-only automations for run-while-closed refresh | In-app HEAD-trigger covers other platforms; the sidecar refresh is a Windows bonus, matching §4.5.2's existing asymmetry |

---

## 6. Sequencing

1. **Phase A (M)** — storage + build pipeline + Wiki tab (human-readable day one).
2. **Phase C (S–M)** — tools + bridge exposure + auto-corpus + index-page layering. (Pulled ahead
   of polish deliberately: agent surfacing is the differentiator and is mostly wiring.)
3. **Phase B (M)** — claims-based freshness + triggers + refresh template.
4. **Phase D (M–L)** — groundedness judge, mermaid repair loop, eval fixture, Vault/repo export,
   page history.

A–C together ≈ the original §6.15 "Effort: L" estimate, but front-loads the parts that make Relay
distinct (wiki-for-every-agent) before the parts that are table stakes (verification polish).

---

## 7. Sources

- In-repo: full code map of `src-tauri/src/{db,chat,git,automation_triggers,vault,agents_md,docs_index,docs_watcher,mcp_tools_bridge}.rs`, `src/state/ui.ts`, `src/components/{chat,vault,settings}` (2026-10-01 pass, line anchors above).
- [DeepWiki](https://deepwiki.com) (Cognition) — hosted repo wikis + persistent index powering Devin Search; [Devin docs: DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki). [research]
- [Google Developers Blog: Introducing Code Wiki](https://developers.googleblog.com/introducing-code-wiki-accelerating-your-code-understanding/); [CodeWiki paper, arXiv 2510.24428](https://arxiv.org/abs/2510.24428) (ACL 2026 Findings); [FSoft-AI4Code/CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki); [codewiki.google](https://codewiki.google). [research]
- [langchain-ai/openwiki](https://github.com/langchain-ai/openwiki) — Grounded Claims, OKF output, MCP search/read tools, claim-evidence updates, CI docs PRs. [research]
- [AsyncFuncAI/deepwiki-open](https://github.com/AsyncFuncAI/deepwiki-open) — open-source clone pipeline (analysis → wiki + Mermaid → RAG chat). [research]
- Docs-as-code drift consensus: [Falconer: docs-as-code](https://falconer.com/guides/docs-as-code/); [RepoDoc, arXiv 2604.26523](https://arxiv.org/html/2604.26523v1) (knowledge-graph traceability). [research]
- Claims above marked **[research]** come from secondary sources and were verified against the
  primary repos/papers on 2026-10-01 only to the depth shown; re-verify specifics (OKF version,
  CodeWikiBench numbers) before building against them.
