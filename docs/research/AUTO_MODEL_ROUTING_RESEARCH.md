# Auto Model Routing — Research & Implementation Design

*Date: 2026-09-06 · Status: Phases 0–3 IMPLEMENTED (local models intentionally excluded from Auto per product decision — see §4); Phase 4 (OpenRouter-auto delegation, learned classifier) not started.*

**Shipped:** Phase 0 (`chat.last_selection` seeding), Phase 1 (`auto` provider end-to-end: DB `auto_model` column, `set_chat_session_auto` command, picker Auto entry, send-time resolution + write-back + disclosure), Phase 2 (`error_class.rs` pre-stream failure classification, `chat/model_health.rs` TTL-based cooldown/credit/key state, transparent fail-over along the resolver's ranked chain with disclosed `chat:status` hand-offs), Phase 3 (`CostClass` from the pricing table + `:free`, Quality/Balanced/Economy bias via the `chat.auto.bias` setting and the Auto pane footer).

**Problem.** Users must choose a model every time they come back to Relay, and they have no way to know which of their many models (6 agent CLIs, cloud providers, local GGUF) actually work right now, which are free, and which need credits. Proposal: an **Auto mode** that routes each request to an appropriate *available* model.

---

## Part 1 — Diagnosis: why users re-choose a model every launch

There is no login screen; the friction is a persistence gap. Relay already persists selection at three layers, but the write path is incomplete:

| Layer | Where | Status |
|---|---|---|
| Per-session | `chat_sessions.provider` + `chat_sessions.model` | ✅ Works — existing chats remember their model |
| Per-provider default | `app_settings` key `chat.<provider>.model` (`set_chat_default_model`, `chat\commands.rs:3674-3687`) | ⚠️ Only written for built-in cloud providers; **harness/ACP picks and `local_gguf` picks never write it** (`chat.ts:1842-1855` skips them deliberately) |
| Active provider | `chat.active_provider` (`set_chat_api_key`, `commands.rs:3634`) | ⚠️ Only set when configuring a key; `local_gguf` is never honored on reopen (`commands.rs:3731-3742`, because the sidecar dies with the app) |

**Resulting failure loop for a new chat:** `ChatView.tsx:851-872` and `useNewChatAction.ts` seed new chats with `config.provider ?? "openai_compatible"` and `config.model ?? ""`. If `chat.<provider>.model` is empty (which it is whenever the user's last pick was a harness CLI, an ACP agent, or a local model — i.e., the majority of Relay usage), the fresh chat lands on the keyless `openai_compatible` provider with an empty model, and sending fails with "no API key configured" (`commands.rs:1617`) or "no model configured for this chat" (`commands.rs:1659,1661`). The user then has to open the picker — every session.

**Fix before/with Auto:** persist a single global `chat.last_selection = {agent, provider, model}` written on *every* `pickModel` (`AgentModelPicker.tsx:629-640` → `ChatView.tsx:670-706`), and seed new chats from it. This alone removes most of the reported friction.

---

## Part 2 — Current architecture (what the router must plug into)

### Selection model
- One atomic pick per session: `AgentModelSelection {agent, provider, model}` (`AgentModelPicker.tsx:78-82`). `chat_sessions.{agent, provider, model}` drive the entire send path (`commands.rs:1335-1424`). A router must write all three coherently or resolve at send time — partial updates cause the known stale-state bugs (local 400s when display name ≠ loaded path, `commands.rs:1637-1664`; CLI respawn on model change, `chat.ts:1827-1836`).
- The picker already computes an **available set**: installed CLIs (`--version` probe, 30s TTL, `commands\pty_cmds.rs:287-318`), keyed providers (`has_key`), scanned GGUF files. This is exactly the router's primary input.

### Providers
- `ChatProviderId` enum (`chat\providers.rs:12-19`): Anthropic, OpenAI, AnthropicCompatible, OpenAICompatible, OpenRouter, LocalGguf. Keys in OS keychain (`relay:chat:<provider>`, `secrets.rs:429-451`), never returned to frontend.
- Model lists are **fetched live** from `{base}/v1/models` including `context_window` (`list_chat_models`, `commands.rs:3790-3934`); local models come from a filesystem GGUF scan. A `/v1/models` call is the de-facto key validator (401 on bad key) — no dedicated ping exists.
- Default models are hardcoded per provider (`providers.rs:429,619,875,926`).

### Send path & error handling
- `send_chat_message` (`commands.rs:1297+`) → provider match → optional llama-server auto-warm respawn (`commands.rs:1426-1608`) → key from keychain → model resolution → `ChatManager::send` (`chat\mod.rs:299-341`) → SSE tool loops (`streaming.rs:943,1334`).
- Errors surface as raw `HTTP {status}: {body}` strings → `chat:error`. **No 401/402/429 classification, no retry, no fallback.** The only recovery paths are context-overflow compact-and-retry (`error_class.rs:18-52` + `cloud_compact.rs`) and the cache-mark strip retry (`streaming.rs:1049-1069`). An `error_class.rs` extension is the natural home for error classification.
- Mid-stream failures (provider error events after 200 OK, `providers.rs:512-525,685-691`) happen *after* tokens are partially emitted — you cannot silently re-route those.

### Local models
- Exactly **one** chat sidecar (`local_models.rs:613-622` stops any existing sidecar before starting a new one). Routing to a local model = a spawn + `/health` poll + ngl-ladder OOM retry (`local_models.rs:693-904`) that **stomps whatever is loaded**. It's a swap, not a connection. Sends into a dead local session already auto-respawn.

### The 6 CLIs
- Relay **does** control CLI models per turn: `claude --model`, `kimi -m`, `opencode -m`, `pi -m`, `omp --model`, `commandcode -m` (`agent_sessions.rs:2237-5494`), with alias remapping for Claude (`resolve_claude_model_id`, `agent_sessions.rs:1181`) and respawn on model mismatch (`agent_sessions.rs:1107`; frontend kills the CLI, `chat.ts:1827-1836`).
- Per-CLI model catalogs: static fallback in `harnessModels.ts:20-59`, live config discovery in `harness_config.rs:45+` (reads each CLI's own settings: `~/.claude/settings.json`, `~/.kimi-code/config.toml`, `opencode models`, `pi --list-models`).
- **No auth/credit/quota visibility for CLIs** — only `is_installed()`. Availability for a CLI model can only be validated passively (turn failure text, exit codes).

### Cost data (router input that already exists)
- `cost_events` (harness panes) + `chat_messages` cost columns (chat turns) → rollups (`db\cost_v2.rs:92-163`), per-model pricing table + user overrides, local models priced by electricity. Per-project monthly budgets exist but are **alert-only** (`commands\budget.rs`).
- Gotcha: unknown cloud model ids price at $0 (`pricing.rs:42-52`) — a budget-aware router must treat unpriced as *unknown*, not free.

### Existing auto/default logic (full inventory)
`chat.active_provider` reopen, `chat.<provider>.model` defaults, harness default model auto-apply (`ChatView.tsx:269-275`), `get_agent_actual_model` per turn, local auto-warm, compaction summarizer provider. **No cross-provider router, no fallback chain, no capability/health probe beyond the picker's availability filter.**

---

## Part 3 — How the industry does it

### Shipped "Auto" modes
| Product | Mechanism | Notable details |
|---|---|---|
| **OpenRouter Auto** (`openrouter/auto`) | Fast classifier → ~30 task types → candidates ranked by 7-day "Share of Spend" market index → `cost_tier` band (`low…max`) → primary + fallback list | Free (pay the chosen model's rate); `X-OpenRouter-Metadata` header reveals chosen model + task type; sticky sessions via `session_id` to protect prompt cache; degrades to a default set, "a request never fails because routing hiccuped"; supports `allowed_models`/`excluded_models` wildcards. Reported: default tier cut MMLU-Pro spend $393→$141 at ~equal quality. (docs/guides/routing/routers/auto-router; blog Aug 2026) |
| **GitHub Copilot Auto** | Two systems: real-time **system health/availability** + **task complexity**; routes "along natural cache boundaries" | 10% discount for using Auto; **guarantees a 0-credit model when premium quota is exhausted**; hover shows model + multiplier; GA docs say mid-session model switching "increased cost without ample improvements in quality" |
| **Cursor Auto** | In-house router, three biases: Intelligence / Balance / Cost | ~60% cost reduction claimed vs hand-picking frontier; users still ask "show which model handled each step" (disclosure gap) |
| **Windsurf "Adaptive"** | Auto flagged `is_recommended: true`, per-model credit multipliers visible in picker | Auto is literally the recommended default entry |
| **Gemini CLI** | "Auto (Gemini 3)" picks Pro vs Flash by task complexity; Manual pins | Auto doesn't override sub-agents |
| **Zed** | **No auto** — community thread demands exactly Relay's feature (issues/47416) | Evidence of demand |
| **Cline** | No routing; two cautionary lessons: auto-switching without notification caused backlash (#4369); selection must persist across sessions; auto-populate models from `/v1/models` (#12340) | |
| **Codex CLI** | "Auto" = dynamic reasoning effort *within* one model, not cross-model routing | Alternative meaning of "auto" |

### Routing frameworks
- **RouteLLM (LMSYS):** classifiers trained on 100K+ Chatbot Arena pairs; matrix factorization best. **95% of GPT-4 quality with only 26% strong-model calls (~48% cheaper; up to 85% cost cut in their setting).** Tunable threshold = the cost/quality dial.
- **RouterBench (Martian/Berkeley) — the honest caveat:** "on the majority of tasks, basic routing systems do no better than the Zero router" (always-pick-the-right-single-model). Cascading (cheapest-first, escalate on quality signal) beat a single big model. Don't expect magic from learned routing alone.
- **NotDiamond:** powered OpenRouter Auto 2025-era; now sells router training on your own eval data.
- **LiteLLM Router — the production reference for reliability mechanics:** routing strategies (cost-based, latency-based, least-busy, usage-based); **immediate cooldown on 429** (honor `retry-after`), N-fails → cooldown (default 3 fails / 5s), 401 → zero retries + disabled; priority-tier fallback chains with per-tier retries; `context_window_fallback_dict` (overflow → bigger model); **pre-call checks** filter deployments by context fit before the call; session affinity pinning.
- **Semantic Router:** embeddings + thresholds, ~10ms, fully local, explainable — the template for an offline classifier.

### Availability detection semantics
- **401** → bad key: disable provider until user fixes it; *never* auto-fail-over to hide a config bug.
- **402** → needs credits: keep the model listed with a "needs credits" badge; exclude from auto.
- **429** → honor `retry-after`, cooldown the model, fail over. Anthropic spend-cap 429 (`enforced_spend_limit_reached`) has **no retry-after and retrying cannot succeed** — surface "billing action needed". OpenAI: failed requests still count against limits (don't hammer); `slow_down` 429s can fire within stated limits.
- **5xx/503** → backoff with jitter, then fail over. **Context-overflow** → re-route to bigger window, don't retry same model (Relay already compacts).
- **Open WebUI cautionary tale:** merged model lists across connections with no circuit breaker → one dead endpoint blocks the UI up to 10s, models "disappear". Fix: parallel per-provider fetches + cache last-known lists with stale badges.

### Local↔cloud hybrid
- Local liveness: llama-server `/health` = process up, *not* model ready (Relay already polls properly with its spawn health check); Ollama uses `/api/tags`.
- Robust pattern (OpenClaw gateway): **probe health → start process if down → wait for readiness → route**.
- **The privacy rule:** local→cloud fallback must never be silent — a prompt meant to stay on-device can leave the machine. OpenClaw users forced silent subagent cloud-fallback to be replaced with a loud failure (issue #43945). Make the boundary a consent point and log every crossing.

### UX patterns (copy these)
1. Auto sits at the **top of the picker, marked recommended**; manual remains full-fidelity.
2. **Always disclose what ran** (Copilot hover, OpenRouter metadata). Antigravity's opacity caused a trust backlash. Differentiator: show *why* — "routed to X because: image attached / 200k context / free model".
3. **Sticky sessions** — never switch mid-conversation without cause (cache economics + Cline backlash). Re-evaluate at conversation boundaries.
4. **Cost visibility aligned with auto** (multipliers in picker; 0-credit guarantee like Copilot).
5. **Last manual pick persists forever** and auto never silently overrides a pinned choice.

---

## Part 4 — Recommended design for Relay

**Ship a deterministic, client-side "rules + health-state" router with free-first ordering and sticky sessions** (industry analogs: LiteLLM Router + Copilot's reliability mode + OpenRouter's cost_tier/stickiness). Defer learned/LLM classifiers — RouterBench shows they rarely beat good rules on typical tasks, and Relay's wins (availability, credits, cost) are all rule-expressible. Optionally delegate to `openrouter/auto` later for OpenRouter-keyed users.

### 4.1 Data model: a candidate registry with health state
Build a `ModelCandidate` view unifying all sources the picker already knows about:

```
{ source: harness|acp|builtin|local,
  provider_id / harness_id, model_id, display_name,
  context_window (from list_chat_models / GGUF metadata / harness_config),
  capabilities: {vision, tools} (capability table; continue.dev-style detection),
  cost_class: free | cheap | standard | premium | unknown,
    // local = free (electricity-priced); unknown ≠ free
  availability: {
    installed_or_keyed (already computed),
    key_valid (last /v1/models result + timestamp),
    needs_credits (saw 402 / spend-cap 429),
    cooldown_until (saw 429 → now + retry-after, else now + 60s),
    local_loaded (sidecar running + which model)
  } }
```

Persisted as an `app_settings` blob or small table (`model_health`), updated by: existing `list_chat_models` results (they already capture context windows), a new background `refresh_model_health` command (parallel per-provider `/v1/models` pings with cached stale results — never blocking the UI), passive turn outcomes, and error classification (4.3).

### 4.2 Selection: "auto" as a virtual selection resolved at send time
- Add `auto` as a picker entry at the top (and a valid `chat_sessions.provider`/agent value). Store the session as `auto`; **resolve the concrete model in `send_chat_message` right before dispatch**, then write the resolution back to the session row (coherent triple-write, satisfying constraint #1) and emit it in a `chat:status`/metadata event for disclosure.
- Selection pipeline (all local, ~0ms):
  1. **Hard filters:** context window ≥ prompt size (+headroom); image attachments → vision-capable only; tool-needing turns → tool-capable only; availability gates (key valid, not needs_credits, not cooling down).
  2. **Stickiness:** if the session previously resolved to a candidate that's still eligible → keep it (re-evaluate only when it drops out).
  3. **Ranking with a user cost bias** (three positions, Cursor-style — call them *Quality / Balanced / Economy*): Quality prefers premium tiers; **Economy prefers free/local first, then cheap, then paid** (Copilot's 0-credit guarantee: if budget/quota exhausted, auto always lands on a free or local candidate); Balanced mixes. Local-first ordering pays the sidecar-swap cost only when it's the top-ranked eligible free option and the user opted into local in auto (setting: "use local models in Auto", default **off** — because of constraint #2, a local route evicts whatever's loaded).
  4. **Fallback chain:** ranked list becomes the ordered fallback; on pre-stream failure, walk the chain.
- Harness CLIs participate as ordinary candidates (Relay already passes `-m` per turn and respawns on change). Caveat surfaced in UI: routing to a *different* CLI model respawns that pane's process.

### 4.3 Reliability machinery (new, in `error_class.rs` + streaming)
Extend `error_class.rs` (which already classifies context overflow) with `auth_error | payment_required | rate_limited {retry_after} | server_error | model_not_found`. Wire the classifier wherever `HTTP {status}: {body}` is produced (`streaming.rs:166-177,491-494`, `providers.rs:512-525,685-691`):
- **Pre-stream failures** → update health state (cooldown / needs_credits / key_invalid) → **transparently fail over to the next candidate in the chain**, prepend a one-line status event ("model X unavailable, trying Y").
- **Mid-stream failures** → do **not** silently re-route (tokens already emitted/persisted). Surface the error + a one-click "continue with Y" button.
- 401 never fails over — it surfaces "fix your <provider> key" and disables that provider until revalidated. Anthropic spend-cap 429 maps to needs_credits ("billing action needed"), not a retry.
- Background `refresh_model_health` validates keys lazily via `list_chat_models` (already exists) — no new provider traffic pattern.

### 4.4 UX
- **Auto chip at top of `AgentModelPicker`** with a badge showing resolved model; per-response disclosure line ("via Claude Sonnet 4.5 · free · 200k ctx — picked: image attached"), the "why" that Cursor/Copilot don't show.
- **Needs-credits badge** on 402'd models; they stay visible in manual pick but are excluded from auto until revalidated.
- **Never silent local→cloud** (and cloud→local): if Auto's chain crosses the local/cloud boundary mid-failure, show it ("local model failed, continuing in the cloud — send anyway?" once, then remembered per setting).
- **Last manual pick always persists** (Part 1 fix) and a manual pin is never overridden by auto — auto only owns sessions explicitly set to auto.
- Compaction summarizer and other auxiliary calls can route independently (they already have sidecar/cloud selection).

### 4.5 Explicitly deferred
- **`openrouter/auto` delegation** (phase 2+): when the user has an OpenRouter key with credits, Auto can offer "smart (OpenRouter)" as the ranking brain for OpenRouter-hosted models — free, battle-tested, returns task-type metadata — but it can't see Anthropic-direct, CLIs, or llama-server, so it's a ranking source, not the architecture.
- **Learned classifier** (RouteLLM-style): only after collecting preference data (thumbs down + "retry with another model" events are free RouteLLM-style training pairs). RouterBench's caveat says don't start here.

---

## Part 5 — Phased implementation plan (mapped to code)

**Phase 0 — Kill the re-choose friction (small, independent, ship first)**
1. New setting `chat.last_selection = {agent, provider, model}` written on every `pickModel` (`ChatView.tsx:670-706`), including harness/ACP/local picks.
2. Seed new chats from it in `ChatView.tsx:851-872` and `useNewChatAction.ts` (fall back to current behavior). For local, restore the sidecar via the existing auto-warm path instead of falling back to `openai_compatible`.
3. Optionally: also write `chat.<provider>.model` for harness picks so per-provider defaults stop being cloud-only.

**Phase 1 — Auto entry + rules router (the feature)**
1. `ModelCandidate` registry + health store (settings blob) fed by picker inputs, `list_chat_models` cache, GGUF scan, harness_config.
2. `auto` selection value end-to-end (picker chip → session row → send-time resolution in `send_chat_message` → triple-write-back → disclosure event).
3. Filters (context, vision, tools) + sticky + Quality/Balanced/Economy ranking, local-in-auto opt-in off by default.

**Phase 2 — Failure handling & health**
1. `error_class.rs` classification (401/402/429+retry-after/5xx/model-not-found) at all raw-HTTP sites.
2. Cooldown/needs-credits/key-invalid state updates + background lazy revalidation.
3. Pre-stream transparent fail-over along the ranked chain; mid-stream "continue with Y" affordance.

**Phase 3 — Cost & budget awareness**
1. cost_class per candidate (rollups + pricing table; unknown ≠ free).
2. Economy mode = free-first with Copilot-style 0-credit guarantee; optional budget guard reusing `check_budgets` state to force Economy.

**Phase 4 — Optional upgrades**
OpenRouter-auto-as-ranking-source; RouteLLM-style classifier trained on collected feedback; latency-based ranking from observed stream TTFB (data already flows through SSE).

### Constraints the design respects (from the code audit)
1. Selection is an atomic triple — auto resolves at send and writes back coherently.
2. `local_gguf` is a single-slot swap with spawn cost — local participates in auto only via opt-in.
3. No fallback machinery exists today — classification + chains are net-new but have a natural home (`error_class.rs`, the `HTTP {status}` sites).
4. No per-key health signal exists — `list_chat_models` doubles as the validator; CLI auth stays passive/observational.
5. Unpriced models are unknown-cost, not free — cost-aware ranking treats them accordingly.

---

## Sources

- OpenRouter Auto Router docs: https://openrouter.ai/docs/guides/routing/routers/auto-router · launch post: https://openrouter.ai/blog/announcements/introducing-the-new-auto-router/ · 2025 NotDiamond era: https://openrouter.ai/blog/announcements/happy-new-year-introducing-a-new-auto-router/
- Copilot Auto: https://code.visualstudio.com/blogs/2025/09/15/autoModelSelection · https://github.blog/changelog/2025-09-15-auto-model-selection-for-copilot-in-vs-code-in-public-preview/ · GA: https://docs.github.com/en/copilot/concepts/models/auto-model-selection
- Cursor: https://cursor.com/help/models-and-usage/available-models · https://forum.cursor.com/t/show-which-model-handled-each-step-when-using-auto-mode/164163 · third-party analysis: https://explainx.ai/blog/cursor-router-auto-model-selection-july-2026
- Windsurf/Devin models: https://docs.devin.ai/desktop/models · Gemini CLI: https://github.com/google-gemini/gemini-cli (docs/cli/model.md) · Zed demand: https://github.com/zed-industries/zed/discussions/47416
- Cline lessons: https://github.com/cline/cline/issues/4369 · https://github.com/cline/cline/issues/12340 · Continue capability detection: https://docs.continue.dev/customize/deep-dives/model-capabilities
- RouteLLM: https://arxiv.org/html/2406.18665v4 · https://github.com/lm-sys/routellm · https://www.lmsys.org/blog/2024-07-01-routellm/
- RouterBench: https://withmartian.com/post/introducing-routerbench · Martian judges: https://withmartian.com/post/judge-aggregator · NotDiamond: https://docs.notdiamond.ai · Semantic Router: https://github.com/aurelio-labs/semantic-router
- LiteLLM Router: https://docs.litellm.ai/docs/routing
- Rate-limit semantics: https://developers.openai.com/api/docs/guides/rate-limits · https://platform.claude.com/docs/en/api/rate-limits
- Open WebUI multi-endpoint failures: https://docs.openwebui.com/troubleshooting/connection-error/ · https://github.com/open-webui/open-webui/issues/8854
- Local/cloud hybrid: https://ollama.com/blog/cloud-models · https://docs.openclaw.ai/gateway/local-model-services · https://docs.anythingllm.com/changelog/v1.13.0 · silent-fallback backlash: https://github.com/openclaw/openclaw/issues/43945 · llama-server /health caveat: https://github.com/ggml-org/llama.cpp/issues/20684
