# Self-Improving Artifacts — Design

Status: design — P0 (registry) + P1 (engine) implemented · 2026-09-04, updated 2026-09-05
Scope: Skills, Loops, Prompt Templates, Automations

> **Implementation status (2026-09-05):** the observe/propose/evaluate/promote loop described in §6–§8 ships as `src-tauri/src/improve_engine.rs` + `src-tauri/src/commands/improve_cmds.rs` (20 commands) + `src-tauri/src/db/improve.rs` (improve_* tables + `loop_sessions`), with the Settings → Improvements panel (`src/components/settings/ImprovementsPanel.tsx`). Later phases remain as designed below.

---

## 1. Summary

Relay already ships four kinds of behavioral artifacts — **Skills**, **Loops**,
**Prompt Templates**, and **Automations** — and already has a unified artifact
proposal system (`src-tauri/src/artifacts/`, type =
`"skill" | "loop" | "prompt_template" | "automation"`) where the model proposes
an artifact and the user accepts it. What it cannot do today is *learn*: an
artifact that fails, gets edited, or produces corrections keeps failing the
same way forever.

This document designs a closed-loop self-improvement system on top of the
existing subsystems:

```
        ┌─────────────┐   evidence    ┌──────────────┐   proposals   ┌───────────┐
        │  OBSERVE    │──────────────▶│  PROPOSE     │──────────────▶│  EVALUATE │
        │ failure +   │               │ reflective   │               │ regression│
        │ correction  │               │ diff + why   │               │ + judge   │
        │ signals     │               └──────────────┘               └─────┬─────┘
        └─────▲───────┘                                                    │ pass
              │ live metrics                                               ▼
        ┌─────┴───────┐   rollback    ┌──────────────┐    canary     ┌───────────┐
        │  MONITOR    │◀──────────────│  ACTIVE (vN) │◀──────────────│  PROMOTE  │
        └─────────────┘               └──────────────┘               └───────────┘
```

Six capabilities, mapped to sections:

| Capability | Section |
|---|---|
| Detect failures + user corrections during execution | §5 |
| Generate proposed artifact improvements | §6 |
| Evaluate improvements before applying | §7 |
| Artifact versioning | §4 |
| Regression testing for updated artifacts | §8 |
| Automatic promotion of validated versions | §9 |

**Non-goals (v1).** No editing of the hardcoded CORE system prompt
(`chat/prompts.rs` `core_prompt_base*`) — those are code with pinned byte
budgets and tests. No cross-artifact rewrites (one proposal touches one
artifact). No silent edits: automation always produces a reviewable diff, and
full-auto promotion is opt-in per artifact.

---

## 2. What exists today (grounding)

| Artifact | Storage | Runtime use | Telemetry today |
|---|---|---|---|
| Skill | Filesystem `SKILL.md` in `~/.claude/skills/`, `~/.agents/skills/` (`installed_skills.rs`); legacy `skills` DB table; built-ins via `include_str!` | Passive injection into system prompt (`chat/prompts.rs:708`), `get_skill` tool, `/slug` expansion | **None** — invocation is not recorded at all |
| Loop | Filesystem `LOOP.md` (`installed_skills.rs` kind `loops`); goal loop runtime is **frontend-only** ephemeral state (`src/state/chat.ts` `LoopState`, `GOAL_LOOP_MAX = 10`) | `LOOP_STATUS: continue|complete|blocked` sentinel parsed by `parseLoopStatus`; malformed ⇒ stop | **None persisted** — iterations vanish on session close |
| Prompt template | Settings JSON `prompts.templates` (`{id, name, body, trigger, createdAt}`); artifact proposals also land in `skills` table + filesystem | Composer `/` menu fill-in (`ChatComposer.tsx`), skill injection | **None** |
| Automation | `automations` + `automation_runs` tables (status: `running`/`ok`/`skipped`/error text, summary, source) | Scheduler `automations.rs`, headless `bin/conduit_automation.rs`, Task Scheduler | ✅ **Mature**: per-run status/summary, `last_status`, webhook + failure email |

Correction signals that already exist but are not recorded as feedback:

- **Edit-to-fork / regenerate** — `supersede_chat_tail` → `mark_branch_superseded`
  stamps `superseded_by` (`db/chat.rs:745`); the strongest "the answer was wrong
  enough that I rewrote my prompt" signal.
- **Stop/cancel** — `cancelStream` + `stoppedPartial` map (`src/state/chat.ts`).
- **Errors** — `chat:error` events; only classifier today is `error_class.rs`
  (`context_overflow`).
- **Explicit thumbs up/down — does not exist** (net-new, §5.3).

Also existing: `automation_runs` is the template for a generic run-record
table, and `app_settings` JSON keys + idempotent-DDL migrations
(`init_schema`, duplicate-tolerant `ALTER`s, `db.migration.*.backfilled`
markers) are the established schema-evolution pattern.

---

## 3. Prior art this design borrows from

- **Voyager** (arXiv:2305.16291) — skill library where every skill must pass an
  *environment validation* before entering the library; execution feedback
  iteratively refines a skill. → §7 (evaluation gate) and §8 (regression suite).
- **GEPA / DSPy, TextGrad** — reflective prompt evolution: an LLM reads
  *structured execution traces* (inputs, outputs, failures, judge feedback) and
  proposes a targeted text edit; candidates are scored on a validation set and
  a champion/challenger comparison decides adoption. → §6 (proposer prompt) and
  §9 (promotion rule).
- **promptfoo-style CI regression evals** — declare test cases + assertions
  (deterministic and LLM-rubric), run on every change, diff against the
  incumbent, gate merges. → §8.
- **Shadow / canary / champion-challenger rollout** — canary proves *safe*,
  A/B proves *better*; online metrics drive promote-or-rollback. → §9.

---

## 4. Artifact versioning

### 4.1 Principle: versions are immutable, pointers move

Every artifact gets an append-only version history in the DB, regardless of
where its *payload* canonically lives (filesystem / settings / DB). A version
row stores the full resolved body so history survives edits and deletions of
the live file; the live copy is just a materialization of the `active`
version.

### 4.2 Schema (repo migration style: idempotent DDL in `init_schema`)

```sql
-- One row per artifact known to the improvement system.
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,                  -- uuid
  kind TEXT NOT NULL,                   -- 'skill'|'loop'|'prompt_template'|'automation'
  ref_key TEXT NOT NULL,                -- backend-specific id: skill slug, template id, automation id
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, ref_key)
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,             -- 1..n per artifact
  body TEXT NOT NULL,                   -- full resolved content (SKILL.md body, template body, automation prompt)
  meta_json TEXT,                       -- kind-specific: vars for templates, cron+harness for automations, frontmatter
  origin TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'auto_proposal' | 'import'
  parent_version INTEGER,               -- which version this was derived from
  created_at INTEGER NOT NULL,
  UNIQUE(artifact_id, version)
);

-- Movable pointers. `channel` keeps rollout explicit and rollback O(1).
CREATE TABLE IF NOT EXISTS artifact_channels (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,                -- 'active' | 'candidate' | 'shadow'
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, channel)
);
```

`shadow` exists for §9's canary: a candidate version served to a *fraction of
qualifying executions* while `active` keeps the rest.

### 4.3 Mapping to the four storage backends

| Kind | `ref_key` | Canonical live copy | Sync rule |
|---|---|---|---|
| skill | slug | `SKILL.md` in harness skill roots | On promote: write body via existing `save_installed` + `invalidate_skill_cache()`; on manual file edit: importer detects mtime/hash change and records a new `origin='user'` version |
| loop | slug | `LOOP.md` (loops root) | Same as skill |
| prompt_template | template id | `prompts.templates` settings JSON | On promote: rewrite the array entry; version row carries `meta_json = {vars, trigger}` |
| automation | automation id | `automations.prompt` column | On promote: `update_automation`; schedule changes are part of `meta_json` but only ever change via user-approved proposals (§10) |

User hand-edits remain legal: a content-hash check on read (skill/loop files
already flow through a 5-second TTL cache — extend the cache entry with a
body hash) auto-records a new user version, so the improvement loop always
reasons over the true live text.

Initial adoption: `ensure_artifact_record(kind, ref_key)` backfills
`artifacts` + `artifact_versions(v1)` lazily on first observation — no
breaking migration, consistent with the `db.migration.*` marker pattern.

---

## 5. Observe: failure + correction detection

### 5.1 Net-new execution telemetry: `artifact_runs`

Mirror `automation_runs` (status/summary/started_at/finished_at) for the three
kinds that have no run records:

```sql
CREATE TABLE IF NOT EXISTS artifact_runs (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,             -- which version was live
  chat_session_id TEXT,                 -- join to the conversation
  started_at INTEGER NOT NULL,
  outcome TEXT,                         -- 'applied' | 'failed' | 'abandoned' | 'corrected' (NULL while in flight)
  error_code TEXT,                      -- reuse error_class.rs codes
  metrics_json TEXT                     -- kind-specific: loop iterations, retries, tokens (from chat_messages)
);
CREATE INDEX IF NOT EXISTS idx_artifact_runs_artifact
  ON artifact_runs(artifact_id, started_at DESC);
```

Where the hooks live:

- **Skill**: `parse_invoked_skills` (`chat/commands.rs:2677`) already knows a
  turn invoked a skill — insert a run row there; resolve outcome from the
  turn's terminal state (§5.2).
- **Loop**: `startLoop`/`advanceLoop`/`stopLoop` (`src/state/chat.ts`) already
  parse the sentinel; emit `loop:iteration` / `loop:finished{outcome}` events
  (Tauri `emit`, like `automation:run-finished`) so the backend can persist
  iterations, cap-outs, `blocked` exits, and malformed-sentinel stops.
- **Prompt template**: composer insertion (`ChatComposer` template fill) is the
  start event; outcome resolution identical to skills.

Outcome resolution is *deferred*, not synchronous: a run stays open until the
turn (or the loop) reaches a terminal state, then one write classifies it.

### 5.2 Failure signals (kind-specific)

| Signal | Source | Meaning |
|---|---|---|
| automation run failed | `automation_runs.status ∉ {ok, running, skipped}` | already recorded; add `error_code` via `classify_error` |
| automation flapping | ≥3 failures / 5 runs (frontend already derives `healthy|failing` in `automations/shared.ts` — lift to DB query) | recurring failure worth a proposal |
| turn errored | `chat:error` + `error_class.rs` | skill/template run `outcome='failed'` |
| loop malformed sentinel / cap-out / blocked | `parseLoopStatus` stop reason | the loop skill text or goal framing likely needs work |
| retries | same user message re-sent within N minutes after error (already persisted in `chat_messages`) | implicit failure |

### 5.3 Correction signals

| Signal | Source | Strength |
|---|---|---|
| Edit-to-fork on a turn that used the artifact | `superseded_by` populated by `editMessage`/`regenerate` | strong — user rewrote the input or asked again |
| Manual artifact edit shortly after use | file-hash change / template edit within a window of a run | strong |
| Stop + rephrase | `stoppedPartial` + new user turn ≤2 min | medium |
| Delete-message on artifact output | `delete_chat_message` | medium |
| Explicit 👍/👎 on a message | **net-new**: one `artifact_feedback` write from `MessageBubble` (artifact-attributed when the turn invoked one) | strongest, sparse |

Every observation row carries `artifact_id, version, run_id, signal,
evidence_json` (message ids, error codes, diff summaries) so §6's proposer
never guesses — it cites. Retention: raw runs 90 days, aggregated per-version
stats forever (mirrors cost_events rollup philosophy).

---

## 6. Propose: generating improvements

### 6.1 Trigger

A per-kind "improvement sweep" runs when evidence accumulates — not on every
failure:

- automation: ≥3 failed runs in 7 days, or a `healthy→failing` transition;
- skill/loop/template: ≥3 `failed|corrected` runs in 7 days, or 👎 with a
  written reason.

Sweeps are **throttled and de-duplicated**: one open proposal per artifact;
new evidence attaches to it instead of spawning rivals.

### 6.2 The proposer

A one-shot LLM task (reuses the chat one-shot path used by automations,
`run_one_shot_chat`) with a GEPA-shaped prompt: input = artifact body +
version history + **structured evidence bundles** (failure traces, correction
diffs, judge notes) + the artifact's eval pack; output = strict JSON:

```json
{
  "artifact_id": "...",
  "parent_version": 7,
  "change_summary": "one sentence a user can evaluate",
  "unified_diff": "--- a/SKILL.md\n+++ b/SKILL.md\n...",
  "new_body": "full replacement text",
  "root_causes": [{"evidence_run_ids": ["..."], "explanation": "..."}],
  "expected_effect": "what should change in eval metrics",
  "risk_notes": "what could regress"
}
```

Guardrails: the proposer may only *modify text* (body/vars/summary). It cannot
change automation schedules, harness selection, permissions, or scopes —
those fields are stripped server-side from any auto-proposal (§10). Diff and
`new_body` must match (validated server-side); mismatch ⇒ proposal rejected
before costing an eval.

Proposals land as rows in `improvement_proposals`
(status `open → evaluating → passed|failed_eval|applied|rejected|stale`) and
surface in chat reusing the existing `ArtifactProposalCard` pattern — the UX
already teaches users to accept/decline model-proposed artifacts; this is the
same card showing a *diff* instead of a *draft*.

---

## 7. Evaluate before applying

Two gates, both mandatory, run against the **candidate version only** — the
live artifact is untouched until §9.

### 7.1 Static gate (free, instant)

- schema validation via existing `artifacts/validator.rs` + frontmatter rules;
- size budgets (skills already have an injection-cost mindset — mirror
  `core_prompt` byte-budget tests);
- forbidden-change checks (schedule/permission/scope fields unchanged);
- body/diff consistency; no PII added (reuse secret-scanning precedents).

### 7.2 Regression gate: eval packs

Each artifact owns an **eval pack** — a versioned set of golden cases:

```sql
CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  input_json TEXT NOT NULL,      -- simulated user turn / task / template vars
  expect_json TEXT NOT NULL,     -- assertions: substrings, must-use tool calls, rubric id
  source TEXT NOT NULL,          -- 'seed' | 'harvested' (real corrected run) | 'manual'
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
```

Case sources:

1. **Seeds** — 3–5 hand cases at artifact creation (the artifact proposal flow
   already asks for purpose; convert it into cases).
2. **Harvested** — real corrected/failed runs become cases: input = the user's
   turn, expect = derived from the user's correction (their edited message or
   👎 reason). This is the Reflexion-style memory of "what went wrong before".

Execution: each case runs the candidate *and* the champion on the same input
(champion/challenger pairing), through the same runtime the artifact really
uses — skills/loops via sandboxed one-shot chat turns; automations via
`run_one_shot_chat` with a hard timeout (the `MAX_RUN_SECS` precedent) against
a scratch cwd, never the real schedule.

Scoring, in escalating cost order:

1. **Deterministic assertions** — must/must-not substrings, sentinel format
   (`LOOP_STATUS:` present), tool-call shape, JSON validity. Free, exact.
2. **LLM-as-judge rubric** — 1–5 on task-specific criteria (correctness,
   instruction-following, brevity), judged *blind and order-randomized* between
   champion and candidate outputs to control position bias.
3. **Cost/latency guards** — candidate's tokens and `llm_time_ms` (already
   recorded on `chat_messages`) may not exceed champion by >25% without the
   quality win justifying it.

Results persist in `eval_runs` / `eval_results` (per-case pass, scores, cost,
raw outputs) and render as a report card on the proposal.

---

## 8. Regression testing semantics

A candidate **passes** only if:

- ≥95% of enabled cases pass outright;
- **zero regressions** on cases the champion passed (the promptfoo-CI rule:
  a change that fixes one case and breaks another is a *fail*, not a trade);
- judge score ≥ champion − 0.3 on average, and ≥ champion on harvested
  (i.e. previously-failed) cases — the whole point is fixing those;
- cost/latency guards from §7.2 hold.

Eval packs themselves are tested: pack cases carry `source` provenance and a
"pack health" check (a pack that passes everything forever is suspect — flag
stale packs for review, retire cases that no longer discriminate). Flaky
cases (pass/fail flip across two identical runs) are auto-quarantined rather
than allowed to veto candidates.

---

## 9. Promote validated versions automatically

### 9.1 State machine

```
draft ──propose──▶ open ──static+regression gate──▶ passed ──┐
   ▲                                                         │ auto-promote (opt-in per artifact)
   │                                              ┌──────────┴──────────┐
 user reject                                      ▼                     ▼
   └────────────────────────────── shadow/canary ◀── or ──▶ active (vN+1)
                                        │ watch window          │
                                        │ regression?           │
                                        ▼                       ▼
                                   auto-rollback ◀──────── monitored
```

### 9.2 Autonomy tiers (per artifact, default left)

| Tier | Behavior |
|---|---|
| **Manual** (default for automations) | passed proposal waits for one-click Apply in the improvements UI |
| **Auto-apply** | gate pass ⇒ version becomes `active` immediately; previous version retained |
| **Canary** (default for skills/loops/templates once user opts into automation) | pass ⇒ `shadow` serves candidate to qualifying executions for a watch window (e.g. 20 runs or 48h), live outcomes compared; clean window ⇒ promote, regression ⇒ auto-rollback + proposal annotated |

Live canary metrics reuse §5: outcome rate, correction rate, cost per run —
candidate vs champion, same statistic, real traffic. Rollback is a pointer
move (§4.1) plus `invalidate_skill_cache()` — instant and reversible.

### 9.3 Guardrails

- **Caps**: ≤1 auto-promotion per artifact per 24h; proposals need ≥3 distinct
  evidence bundles (no single-failure overfitting).
- **Kill switch**: settings key `improvements.enabled=false` freezes sweeps,
  evals, and promotions (proposals can still be created manually).
- **Audit**: every transition writes `proposal_events` (who/what/when, gate
  scores, diff) — an artifact's full history is replayable from
  `artifact_versions` + `proposal_events`.
- **Blast-radius rule**: an artifact that regresses twice after auto-promotion
  is demoted to Manual permanently (the system loses promotion privileges for
  that artifact, not the user).

---

## 10. Integration map (files to touch)

| Area | Files |
|---|---|
| Schema + migrations | `src-tauri/src/db/mod.rs` (`init_schema` DDL), `db/artifacts.rs` (new queries, sibling of `db/skills.rs`) |
| Telemetry hooks | `chat/commands.rs` (`parse_invoked_skills`), `src/state/chat.ts` loop events + `cancelStream`, `automations.rs` `finalize` (attach `artifact_id`), `db/chat.rs` `mark_branch_superseded` (emit correction signal) |
| Proposer | new `src-tauri/src/artifacts/improver.rs` beside `proposal.rs`/`generator.rs`; JSON contract reuses `schemas.rs` conventions |
| Evals | new `src-tauri/src/artifacts/eval.rs`; harnesses via `agent_sessions::run_one_shot` / `chat::run_one_shot_chat` |
| Materialization | `installed_skills.rs` (`save_installed`, `invalidate_skill_cache`), `commands/automation_cmds.rs` (`update_automation`), `lib/ipc.ts` template save path |
| Commands | new `commands/improve_cmds.rs`: `list_improvement_proposals`, `apply/reject_proposal`, `run_eval_pack`, `list_artifact_versions`, `set_artifact_channel`, per-artifact autonomy tier |
| UI | new *Improvements* section in `SettingsView.tsx` nav (per artifact: version history, open proposals with diff view, eval report cards, autonomy tier); proposal surfacing in chat via `ArtifactProposalCard.tsx` pattern; 👍/👎 in `MessageBubble.tsx` |

---

## 11. Phasing

- **P0 — Telemetry + versioning** (foundation, no behavior change):
  `artifacts` / `artifact_versions` / `artifact_runs` tables, lazy backfill,
  loop + skill run events, 👍/👎, version history UI (read-only).
- **P1 — Proposals + evaluation**: improvement sweeps, proposer JSON contract,
  eval packs (seeds + harvest), eval report cards, **Manual**-tier apply with
  diff review.
- **P2 — Automatic promotion**: canary channel, watch-window monitor,
  auto-rollback, autonomy tiers, kill switch, audit log.
- **P3 — Cross-artifact polish**: pack health, flaky quarantine, per-version
  cost attribution in the Cost dashboard (`artifact_runs` × `cost_events`).

---

## 12. Open questions

1. **Judge model policy** — default to the user's configured cloud provider
   with a hard local fallback? Judge cost is the main recurring spend; should
   it appear as its own line in the Cost dashboard?
2. **Harvested-case privacy** — correction inputs may contain user content;
   cap stored context, offer one-click case deletion (align with
   `research_cache` retention patterns).
3. **Loop runtime persistence** — the goal loop currently lives in frontend
   state only; P0 must decide whether loops get a real backend session record
   (recommended: yes, minimal `loop_sessions` table) or stay event-sourced
   through `artifact_runs` only.
4. **Automations already have runs** — keep two run tables
   (`automation_runs`, `artifact_runs`) or unify? Recommendation: keep
   `automation_runs` as the source of truth and *link* it (`artifact_id`
   column) rather than migrate working code.
5. **Filesystem truth vs DB truth for skills** — if a user edits `SKILL.md`
   while a canary is in flight, the window aborts (hash mismatch ⇒ stale
   proposal). Acceptable; document it.
