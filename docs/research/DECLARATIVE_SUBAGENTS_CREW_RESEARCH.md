# Declarative subagents ("Crew") — research & implementation plan

> **Status:** research complete, not yet built · **Date:** 2026-09-28
> **Scope:** Tier-1 item 5 from `FEATURE_MAP_AND_GAP_ANALYSIS_2026-09-19.md` — "user-defined named agents
> (prompt, tool allowlist, permission scope, model, worktree policy) stored in DB, spawnable via UI, `Task`,
> `spawn_session`, and automations; auto-provision worktrees."
> All internal claims were verified in code on this date (three explorer passes + manual spot-checks of
> every load-bearing anchor). **One correction to the original entry:** the live-web research leg could not
> run in this session (WebFetch/WebSearch unavailable), so Part A is from model knowledge, not a live fetch —
> treat ecosystem details as directional, not citable. Repo facts are cited `file:line` throughout.
> **Prerequisite already landed:** the Windows Job Object kill-on-close work (`17cba67`) is Phase 0 of this
> plan — unattended agent runs must not be able to outlive the app.

---

## Part A — Landscape (from knowledge, not fetched)

The "agent as a markdown file" economy is real and worth matching:

- **Claude Code subagents** — `.claude/agents/*.md` with YAML frontmatter (`name`, `description`, `tools`,
  `model`), body = system prompt. `tools` is an allowlist (or inherit); `model` is optional; agents can't
  spawn agents; the CLI auto-delegates by matching the `description` against the task. This is the format
  the feature-map entry cites. Relay should be **interchange-compatible** here: its export/import is the
  distribution story (git-friendly, shareable, reviewable in a PR).
- **Adjacent prior art:** Cursor rules (always-on `.mdc` context), Roo/Cline "modes" (persona + tool
  restrictions in a picker), OpenAI Agents SDK (agent = instructions + `tools` + `guardrails`; handoffs),
  LangGraph (graph nodes with tool binding). The common denominator everywhere: *name, instructions, tool
  set, model, optional scoped tools/paths*. Nobody has a great answer for isolation — worktree-per-agent is
  the emerging pattern (git-native, reviewable, trivially discarded).
- **What nobody solves well:** enforcement parity. When an agent runs on someone else's CLI, the app
  cannot restrict that CLI's native tools — every product either (a) only offers provider-API engines for
  restricted agents, or (b) ships a hook layer and hopes. Relay already has (b) (`hooks.rs`) AND the
  in-process enforcement primitives; the plan leans on both and is honest where enforcement stops.

**Positioning:** Relay's differentiator is that it has the *only* desktop shell with BOTH a provider-API
subagent loop (fully enforceable) AND harness CLIs + a hook layer (advisory, plus scoped denies). The
"Crew" product should make that distinction visible in the UI rather than pretend it's uniform.

---

## Part B — What exists today (verified)

### B.1 Subagents: one hardcoded, read-only, depth-1 system

| Aspect | Reality | Anchor |
|---|---|---|
| Tool | `Task` (unconditional in both spec builders) | `chat/tools/mod.rs:164`, `specs.rs:294,661` |
| Params | `description`, `prompt`, `subagent_type` (7-value enum: explore/edit/analyze/research/write/test/refactor), `model?`, `background?` | `specs.rs:1379-1410` |
| System prompt | hardcoded `format!` + 7-arm `match` on role | `dispatch.rs:985-1009` |
| Tool allowlist | `SUBAGENT_TOOL_ALLOW` — a **const** of 12 read-only tool names | `dispatch.rs:1123-1140` |
| Enforcement | schema filter `subagent_tool_specs` (ReadOnly caps + name filter, both wire envelopes) + execution check in `subagent_run_tool_inner` | `dispatch.rs:1151-1175`, `:1233-1238` |
| Contract test | no mutating tool can enter the allowlist | `dispatch.rs:3280-3305` |
| Depth | 1 — `Task` is not in the allowlist, rejected in inner | `dispatch.rs:1233` |
| Caps | per child: `SUBAGENT_MAX_ROUNDS=100`, result cap 6k chars; **no fan-out cap** (every `Task` in a round is a tokio task) | `dispatch.rs:1145,1147`, `streaming.rs:1187-1222` |
| Permission | subagents bypass the main-loop permission layer entirely; a hook's `ask` degrades to refusal (no approval surface) | `dispatch.rs:1177-1180` |
| Model pick | arg → `chat.subagentModel` setting → parent model; engine-named picks skipped (API loop) | `chat/subagent_model.rs:22,92-127` |
| Process | in-process async task + own HTTP SSE call; no child process, no cwd writes | `dispatch.rs:736-806` |
| Events | `chat:subagent-spawn` / `-tokens` / `-done` → SubagentPanel (`ToolPanel` "agents" tab) | `types.rs:1204-1240`, `panes/SubagentPanel.tsx` |
| Harness CLIs | spawn their own Task/Agent; Relay only *observes* via `tracker.rs`; model/tools/prompt not controllable (`model: None`) | `agent_sessions/tracker.rs:37-39,137-160` |

**There is no persisted agent definition anywhere.** 45 `CREATE TABLE IF NOT EXISTS` statements in
`db/mod.rs` — none agent-shaped. The only "agent" concept is `chat_sessions.agent` (an *engine selector*:
`builtin|local|harness:<id>|acp:<id>`, `db/mod.rs:879`) plus three hardcoded engine-id lists
(`automation_cmds.rs:19-33`, `subagent_model.rs:28`, `specs.rs:1610`). The single knob is the
`chat.subagentModel` settings string.

### B.2 Session Mesh: the other spawn path (capped, engine-selectable, no isolation)

- Tools: `list_sessions`, `read_session`, `search_sessions`, `message_session`, `spawn_session` →
  one dispatcher `execute_mesh_tool` (`session_fabric/mod.rs:468`). Reachable only from the two tool
  dispatchers — **the mesh has zero Tauri commands**, so the UI cannot spawn a mesh child today.
- `mesh_spawn_session` (`:1366-1637`): guards `MAX_SPAWN_DEPTH=2` / `MAX_CHILDREN_PER_PARENT=3 per 24h` /
  `MAX_ACTIVE_SPAWNED=8` (`:38-41`, enforced `:1401-1427`) → creates the `chat_sessions` row
  (`:1532`), sets agent/title/`origin="spawned_by:<parent>"` (`:1536-1541`), emits
  `chat:session-spawn`, then **immediately runs the first turn** (`:1570`). `mode=wait` polls to idle
  (120s ceiling); `background` mails the result back to the parent when the child goes idle
  (`:1185-1260`).
- **No worktree**: the child row's `worktree_path` stays NULL; `SessionRowLite` carries
  `{id, agent, model, project_id, worktree_path}` (`:1697-1703`). Mesh children always run in the parent's
  project root. (Also: `cwd_override` is *not* carried by `SessionRowLite` — noted gap, out of scope.)
- Busy/turn interplay: `session_busy` ORs `ChatState::has_active_stream` and
  `AgentSessionState::is_turn_in_flight` (the lock-free `busy_flags` map, `agent_sessions/mod.rs:83`);
  "a turn is already running" rejections are treated as requeue, not failure (`:913-915`).

### B.3 Worktrees: full-featured but UI-only

- Core: `git::worktree_path_for` / `create_worktree` (`git.rs:197-227`, layout
  `<parent>/<name>-<sanitized-branch>`), `remove_worktree` (`:241`). No `git worktree list`, no prune.
- Session lifecycle: `worktree_cmds::ensure_chat_session_worktree` (idempotent; branch `relay/<id8>`;
  `spawn_blocking`; persists via `db::set_chat_session_worktree`; installs `git_watcher`) at
  `commands/worktree_cmds.rs:45-108`; `set_chat_session_worktree` for teardown/rebind
  (`:120-148`).
- Trigger: **frontend-only** `maybeEnsureWorktree` (`src/state/chat/moduleState.ts:859-878`, setting
  `worktrees.defaultEnabled`, never blocks a send). Backend-spawned sessions (mesh/automation) structurally
  never pass through it. No chat tool exposes worktrees.
- Teardown: delete session / delete all / project unbind-rebind / project removal only
  (`chat/commands/sessions.rs:200,248,346`; `commands/projects.rs:69`). **No turn-end cleanup, no prune.**
- Worktree paths are inside `allowlisted_roots` for git tools (`commands/git_cmds.rs:56-88`).

### B.4 Automations: one blocking headless turn, single funnel

`automations.rs::execute` (`:644-685`) prepends `UNATTENDED_RUN_RULES` then exactly one call:
`agent_sessions::run_one_shot` (CLI harnesses) or `chat::run_one_shot_chat` (API/GGUF). No tool loop, no
mesh, no worktree. The same function serves the run-while-closed sidecar (`bin/relay_automation.rs` links
`relay_lib` with `AppHandle = None`) — the sidecar cannot reach `session_fabric` (private, needs AppHandle).

### B.5 Enforcement seams (the insertion points)

1. **Schema** — `openai_tool_specs` / `anthropic_tool_specs` (`specs.rs:12,394`) filter by *flags*
   (`ToolCaps.web_search`, `.local_docs`, `.research`, …, plus `sandbox.allows_mutating_tools()`). No
   name-level allowlist field exists. The subagent path already proves the terminal name-filter pattern
   (`dispatch.rs:1151-1175`) — including the OpenAI `/function/name` envelope quirk.
2. **Execution** — `dispatch::run_tool` (`:2117`) is THE funnel for built-in-chat calls (main loop and
   `spawn_run_tool` fan-out); per-family decisions happen in `run_tool_inner`'s branch ladder (`:2182`).
   The subagent loop has its own dispatcher (`subagent_run_tool_inner`, `:1233`) — the two must both be
   covered.
3. **Permission scope** — `(SandboxPolicy, ApprovalPolicy)` pairs are already per-session DB columns
   (`db/mod.rs:884-885`), already read by every gate (`permission.rs:300,244,475`) and by harness spawn
   (`claude.rs:31-52`). A declarative scope maps 1:1 onto this pair.
4. **Hooks** — `HookDef` has no session/agent field (`hooks.rs:88`); `run_pre_tool` filters on
   `enabled && event && hook_matches` only (`:869`). But `origin` is already a first-class discriminator at
   every call site: `"chat"`, `"subagent"`, `"harness"`, `"relay_tools"` — one optional field + predicate
   yields per-agent hook scoping with no new plumbing.
5. **Harness reality check** — for engine=`harness:*`, Relay cannot restrict the CLI's own tools. The only
   levers are spawn flags (`claude.rs:79-89`) and `can_use_tool` (`:305`) — and `full_auto`/`bypassPermissions`
   **auto-allow every tool prompt** (verified `claude.rs:392-407`; hook *denies* are the only guardrail
   there). ACP has no permission channel at all (`acp.rs:250`). The relay bridge is deliberately ungated
   except `ALLOWED_RELAY_TOOLS` + hooks + WS token (`mcp_tools_bridge.rs:20-27,172`), and carries no `sid`.

### B.6 UI/registry reality

- Views: `ActiveView` union (`state/ui.ts:17`) + one branch in `App.tsx:489`; overlay classification in
  `lib/viewKinds.ts:9`.
- Right panel: `TABS` array (`ToolPanel.tsx:43`) already has an **"Agents"** tab rendering `SubagentPanel`.
- Settings: `NAV_SECTIONS` (`SettingsView.tsx:198-247`) already has an **"Agents"** section
  (currently just Harnesses) and a "Subagent model" entry under Chat.
- Patterns to copy: list+form panel with optimistic persist = `HooksPanel.tsx` (settings-blob backed);
  entity slice = `state/automations.ts:35`; allowlist editor widget = `PermissionRulesPanel.tsx:21-33`.

---

## Part C — Design

### C.1 Product shape

A **crew agent** is a persisted, named identity: `name`, `description`, markdown **prompt body**,
**tool allowlist**, **permission scope**, **engine + model + effort**, **worktree policy**, and a spawn
budget. The 7 built-in roles (`explore`/`edit`/…) become seeded builtin rows holding the **role
instruction only** (the `match` arms at `dispatch.rs:988-996`); the runtime keeps composing
`role + cwd_line + shared read-only boilerplate` exactly as today, so the migration from `const` to
data is behavior-preserving structurally, and the parity test asserts the *composed* prompt is
byte-identical to today's.

**One engine, three enforcement tiers — surfaced in the UI, not hidden:**

| Engine | Enforcement | Badge in CrewPanel |
|---|---|---|
| `builtin` (provider API / local GGUF) | Full: schema + execution + sandbox/approval policies | "enforced" |
| `harness:<cli>` (Claude Code etc.) | Advisory for the CLI's own tools; Relay-bridge tools fully gated; hook denies still bite | "advisory — CLI tools not restrictible" |
| `acp:<id>` | Advisory (no permission channel) | "advisory" |

### C.2 Family coverage: who can create, who can run, at what tier

**Creating is family-agnostic.** One registry, any engine: the Crew panel (Settings → Agents) lists and
edits every definition regardless of which family will run it; the engine is a field on the row, not a
property of where you created it.

**Running** — the caller family determines the *reaching mechanism*, the agent's engine determines the
*enforcement tier* (C.1):

| Caller family | Reaches crew agents via | Tier | Phase |
|---|---|---|---|
| **The user, by hand** (Run button) | `crew_spawn_run` Tauri command — works with Session Mesh off; the run is a normal, keep-chatting session tagged with the agent | Same as the agent's engine row below | 2.5 |
| Built-in chat (API providers, local GGUF) | `Task` tool — dynamic `subagent_type` enum + explicit `agent` param | **Enforced** — schema filter, execution check, policies all apply | 2 |
| Session Mesh (any parent session, any engine) | `spawn_session`'s new `agent` param | Enforced for builtin-engine agents; advisory for harness-engine | 3 |
| Harness sessions (claude/kimi/opencode/pi/omp/commandcode) | `spawn_session` over the relay-tools bridge — the `Task` tool is deliberately **not** bridged (`mcp_tools_bridge.rs:676`: the harness has its own Task tool) | Relay-tool side enforced; the CLI's **native** tools stay advisory | 3 |
| ACP agents | same mesh path | Advisory (ACP v1 has no permission channel, `acp.rs:250`) | 3 |
| Automations (cron/webhook/file/git/gmail) | `automation.harness = "agent:<id>"`, engine-resolved in `execute` | Unattended rules unchanged; engine-level enforcement | 5 |
| Run-while-closed sidecar | engine-level agent prompts only (crew *sessions* need an `AppHandle`, which the sidecar lacks) | same as automation | 5 |
| A CLI's **own** internal delegation (Claude Code's `Agent` tool, opencode's `task`) | *not addressable* — Relay observes these (`agent_sessions/tracker.rs`) and can neither inject a crew agent into them nor restrict them | n/a | out of scope, stated so it isn't assumed |

Two bridge-contract consequences, both inherited from the 2026-09-28 capabilities-parity work
(`mcp_tools_bridge.rs`, `bin/relay_browser_mcp.rs`): (1) the new `agent` param on
`spawn_session_parameters` must be **mirrored in the static fallback tools/list** in
`relay_browser_mcp.rs` — the static-cover test pins missing *names*, not params, so a stale param would
ship silently and harnesses on the fallback path would never see the option (add a param assertion to
that test); (2) any registry lookup reachable from the bridge needs a real dispatch arm or the
"every advertised bridge tool dispatches" contract test fails — crew enumeration behind the bridge must
be a dispatch, not just a schema line.

"When needed" is **explicit selection in v1** — the model picks a name from the dynamic enum (or the spawn
call passes one). Claude-Code-style automatic delegation by `description` matching is deliberately
deferred (Part E, question 3) because it makes spawn cost and side effects nondeterministic.

### C.3 Schema

```sql
CREATE TABLE IF NOT EXISTS crew_agents (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- also the Task enum value
  description       TEXT NOT NULL DEFAULT '',             -- one line, used for auto-delegation hints
  prompt_md         TEXT NOT NULL DEFAULT '',             -- system-prompt body (markdown)
  tools             TEXT,                                  -- JSON array; NULL = inherit engine default
  engine            TEXT,                                  -- NULL = inherit chat.subagentModel/parent
  model             TEXT,                                  -- 'model' | 'provider::model' | engine::model
  effort            TEXT,                                  -- maps to effort_level
  sandbox_policy    TEXT NOT NULL DEFAULT 'read_only',     -- read_only|workspace_write
  approval_policy   TEXT NOT NULL DEFAULT 'on_request',    -- on_request|auto_edit|full_access
  worktree_policy   TEXT NOT NULL DEFAULT 'inherit',       -- inherit|always|never
  max_rounds        INTEGER NOT NULL DEFAULT 100,          -- clamped to 1..=SUBAGENT_MAX_ROUNDS
  max_concurrent    INTEGER NOT NULL DEFAULT 2,            -- per-agent live-run budget
  builtin           INTEGER NOT NULL DEFAULT 0,            -- seeded roles: cannot delete
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
```

Child sessions point at their agent through **one new column**, `chat_sessions.agent_def_id TEXT
REFERENCES crew_agents(id) ON DELETE SET NULL` (migration in the existing `migrate_*` style,
`db/mod.rs:479-487`; `ON DELETE SET NULL` mirrors `project_id` so deleting an agent never cascades
away sessions). It is deliberately **NOT** the `origin` column: that column is a load-bearing
provenance vocabulary, not a free slot — `spawned_by:<id>` is what `store::spawn_depth` walks for the
mesh depth cap and what `starts_with("spawned_by:")` reports as the “spawned” flag
(`session_fabric/mod.rs:585`), and forks write `fork_of:<id>` (`db/chat.rs:200`). Overwriting it with
`agent:<id>` would silently break depth accounting, so `origin` keeps its meanings (NULL =
human/manual run, `spawned_by:<parent>` for a mesh-spawned crew child) and `agent_def_id` carries the
agent identity. Run *history* is Phase 5 (optional `agent_runs` table); v1 keeps the existing
in-memory SubagentPanel streaming. Deleting an agent with live runs is refused (Phase 1); with only
historical sessions, `ON DELETE SET NULL` leaves those sessions intact and the UI renders them as
“agent deleted”.

A table (not a settings blob) because spawn surfaces validate against it by id, the `origin` FK-by-string
resolves it, and run history will need it — the `skills` table (`db/mod.rs:835`) is the structural precedent.

### C.4 Allowlist resolution (one function, three consumers)

```rust
// chat/subagent_model.rs (or a new chat/crew.rs)
pub fn resolve_allowlist(conn, def: Option<&CrewAgent>) -> Option<Arc<HashSet<String>>>
```
- `None` def → today's `SUBAGENT_TOOL_ALLOW` (unchanged default).
- `tools = NULL` → engine default: builtin = today's 12-name read-only set; harness = the CLI's own
  toolset, i.e. the allowlist governs **only** the Relay-bridge surface there (that is the honest
  boundary of C.1's advisory tier — not “no tools”, but “not the CLI's own”).
- `tools = [...]` → the set, **intersected with the engine's ceiling** (builtin ceiling = read-only +
  `sandbox_policy` mutating half) so a definition can never *widen* past the policy it was granted. The
  existing contract test (`dispatch.rs:3280-3305`) is generalized: "no mutating tool in a builtin
  agent's effective set unless its policy grants workspace_write" + "no spawn-capable tool (`Task`,
  `spawn_session`, `message_session`, `run_shell`) in any default/builtin set" (keeps depth 1).

Consumers: (1) `subagent_tool_specs` filter (generalize to take the resolved set — same `/function/name`
quirk handled once), (2) `subagent_run_tool_inner`'s name check (const → resolved set), (3) optional
`ToolCaps.allow` terminal filter in both spec builders (defense in depth for replayed history; small and
cheap, and it makes the same set expressible for mesh children later).

### C.5 Spawn surfaces

1. **`Task` tool (in-session)** — `subagent_type` becomes a *dynamic* enum: builtin role names ∪ crew agent
   names, rebuilt per turn from the DB (same TTL-cache shape as `list_harness_models`' 30s cache,
   `commands/agent_cmds.rs`). Optional `agent` param (explicit name) wins over `subagent_type`. The engine's
   `full_access`-style shortcut does not apply here — the subagent loop is in-process API, so the
   allowlist + policies are genuinely enforced. Per-call `model` arg still overrides.
2. **`spawn_session` (mesh, Phase 3)** — optional `agent` param; on spawn the def supplies engine
   (through the existing `pick_engine`/`validate_harness_child_model` pre-flight), model, and the
   child row's `sandbox_policy`/`approval_policy`/`effort_level`/`agent_def_id`. Crew spawns keep
   their **own budget** (defined once in item 3, reused here) — the mesh's `MAX_CHILDREN_PER_PARENT=3/24h`
   is a *model fan-out* guard, and counting manual/automated crew runs against it would starve both.
3. **The user, by hand (Phase 2.5 — the first taste of the product)** — every agent gets a **Run** action
   in a new `crew` view (`ActiveView` + `App.tsx:489` branch): agent list (tier badge, description, engine,
   tool count, policy summary) + editor (name/description/prompt body/tool picker reusing the
   `PermissionRulesPanel` widget / scope selects / model pick off the live catalog / worktree policy /
   rounds). "Run" opens a small modal — **task text (required)**, project binding, wait-vs-background —
   and calls a new Tauri command `crew_spawn_run(agent_id, prompt, project_id?, mode)`. The command is a
   **thin fresh path, not the mesh param**: resolve the def → **builtin credential pre-flight** → guard
   (per-agent `max_concurrent` + a `CREW_RUNNING` set) → create the `chat_sessions` row with the def's
   engine/model/policies/effort and `agent_def_id` (the `origin` column stays NULL — a human-initiated
   run; C.3 explains why it must) → provision the worktree when policy says so (C.6) → dispatch the first turn
   through the same primitives `session_fabric::run_turn` uses (`send_chat_message` for builtin engines,
   `AgentSessionManager::send` for harness/ACP) but with a **plain task envelope**, not the mesh's
   `spawn_envelope` (`mod.rs:1678-1691`, which injects mesh awareness a manual run does not need);
   `run_turn` is private, so `crew_spawn` is the public wrapper both callers share. Before the row is
   created, a **credential pre-flight** for builtin engines (the provider key/model the def resolves
   to must exist — mesh only pre-flights harness catalogs today, `mod.rs:1646-1676`) so a misconfigured
   agent fails with one clear error instead of a dead session. The run appears as a **normal chat
   session** — it streams in the chat view, the user can keep talking to it, and the sidebar row is
   tagged with the agent. To make the sidebar update live, `SessionSpawnPayload.parent_session_id`
   becomes `Option<String>` (`types.rs:665-673`) and `meshSlice.onSessionSpawn` (`meshSlice.ts:114`)
   routes a null-parent spawn to a crew-runs list instead of keying `meshChildren` under a phantom
   parent. The work happens even with Session Mesh disabled, and the mesh's 3-children-per-parent cap
   is untouched. This lands at the end of Phase 2 precisely so the first end-to-end user story
   (define → run it yourself → watch it work) ships before the mesh work.
   **Definition-at-spawn invariant:** the run resolves the definition once at spawn; the session row
   keeps the applied engine/model/policies and points at the live row via `agent_def_id`, so editing
   an agent afterwards changes *later* spawns and any in-session `Task` calls it makes — never a
   running turn's already-applied policies.
4. **Automations (Phase 5)** — extend the engine validator (`ALLOWED_AGENTS`, `automation_cmds.rs:19-33`)
   to accept `agent:<id>`; `execute`'s two-arm routing resolves the def's engine first, then hits the
   existing `run_one_shot` / `run_one_shot_chat` branches unchanged. Worktree policy: `inherit` uses
   `automation.cwd`, `always` provisions before the run (see C.6). The sidecar keeps working because both
   one-shots are headless-callable; crew *sessions* (which need AppHandle) do not run in the sidecar —
   stated as a v1 limit, matching the mesh's existing app-only reality (the mesh itself has zero
   Tauri commands today: `lib.rs:138,309-310` register only the module and its state).

### C.6 Worktree auto-provisioning

At the backend spawn seam (between row creation and `run_turn` / before the one-shot), when
`worktree_policy = always` and the project is a git repo:
`git::create_worktree(project, format!("relay/{}-{}", slug(name), &id[..8]))` → persist via
`db::set_chat_session_worktree` → `git_watcher::install` — i.e. exactly `worktree_cmds::ensure_chat_session_worktree`
(`worktree_cmds.rs:45-108`) minus the session-id-derived branch name, refactored to take an explicit branch
so both callers share it. Guard: non-git project or `worktree_path_for` collision → fall back to the
project root with a `substitution_note` in the spawn result (the same honesty the model pre-flight uses).

**Known gap this exposes:** teardown today is manual (delete/unbind only). Agent runs would accumulate
worktrees. v1 ships the join/remove affordance it inherits for free (the ⛓ composer chip calls
`set_chat_session_worktree`), plus a "Keep worktree?" checkbox on run completion (default keep —
auto-pruning unmerged agent work is a footgun). An actual prune policy (age + no-uncommitted-changes)
is Phase 5.

### C.7 Enforcement interop (harness agents)

- **Origin-scoped hooks (Phase 4):** add `origins: Vec<String>` to `HookDef` (default = all), extend the
  filters at `hooks.rs:869`/`:1011` with a predicate over the already-passed `origin`; crew runs pass
  the **hook origin** `agent:<id>` at the pre-tool gate (today the subagent loop passes `"subagent"` at
  `dispatch.rs:1181-1219` — widen the origin string to carry the agent id, *not* its name, so a rename
  can't silently unscope a rule; the hook-origin string is unrelated to the `origin` DB column of C.3).
  A user writes one deny-hook per
  sensitive tool for their advisory agents — the same escape hatch the hooks engine already documents for
  `full_auto` (where `can_use_tool` auto-allows, `claude.rs:392-407`).
- **Permission scope at spawn** is real for the *Relay-tool* surface everywhere (both spec builders and
  both dispatchers read the policies), and real for CLI tools only via spawn flags +
  `can_use_tool` + hooks. The CrewPanel badge says exactly which tier an agent is on — no false promises.

### C.8 Corrections to the original feature-map entry

1. **"matches the Claude Code .md subagent economy"** — the DB is the source of truth, so `.md` is the
   *exchange* format (export/import), not the storage format. Interop is preserved where it matters
   (round-trip), storage is queryable.
2. **"spawnable via `Task`"** — the 7-value `subagent_type` enum is baked into the tool schema
   (`specs.rs:1394`) and a `match` (`dispatch.rs:988`); making it DB-driven means per-turn schema rebuilds
   + a cache, and the enum grows with the user's crew. If a crew gets large (>~20), the right move is a
   meta-tool (`list_agents` / `run_agent(name, …)`) instead of a fat enum — Phase 2 builds the registry so
   either client is possible, and the threshold is called out in the code.
3. **"auto-provision worktrees"** — needs a backend seam that does not exist today (worktrees are a
   frontend-only path) and inherits the missing-teardown gap. Real, but it is its own phase, not a detail.
4. **Effort L is right, but it is 6 phases of S–M** (0 landed · 1 registry · 2 in-chat use · 2.5 manual
   run · 3 mesh fan-out · 4 hook scoping · 5 automations/`.md`/history) — see Part D; the L only holds
   if built whole.

---

## Part D — Phased implementation plan

Each phase is independently shippable, gate-green, and behavior-preserving for users who don't create
agents (the 7 builtins keep their exact prompts/tools).

### Phase 0 — landed: crash-proof trees (`17cba67`)
Job Object kill-on-close at every harness spawn. Nothing to do; prerequisite for unattended agent runs.

### Phase 1 — Registry: definitions without behavior (M)
- `src-tauri/src/db/mod.rs`: `CREATE TABLE IF NOT EXISTS crew_agents` in the `init_schema` batch;
  `migrate_crew_agents_seed` (idempotent, `builtin=1` rows for the 7 roles, prompts copied verbatim from
  `dispatch.rs:985-1009`) gated by an `app_settings` marker like other one-shot backfills (`:532-539`).
- New `src-tauri/src/chat/crew.rs`: `CrewAgent` struct, `list/get/create/update/delete`, builtin-delete
  refusal **and live-run delete refusal** (the in-process running set / `max_concurrent`),
  `resolve_allowlist` (C.4), name/description validation.
- `src-tauri/src/commands/crew_cmds.rs` + `lib.rs` registration (next to the automations block `:640-662`).
- IPC: `src/lib/ipc/crew.ts` (safeInvoke wrappers, `CrewAgent` type mirroring `ipc/hooks.ts` style) +
  re-export from `ipc.ts`.
- Frontend: `src/state/crew.ts` slice (automations-slice shape); `CrewPanel.tsx` list+editor; nav entry
  under Settings → Agents (`SettingsView.tsx:217-222`); tool picker widget reused from the
  `PermissionRulesPanel` pattern.
- Tests: seed idempotency; builtin delete refused; name-uniqueness case-insensitive; allowlist resolution
  matrix (NULL → default; explicit; engine-ceiling intersection).

### Phase 2 — `Task` runs a crew agent (M)
- `chat/tools/specs.rs`: `subagent_type` schema gains dynamic values (name list injected from the cached
  registry — the per-turn spec builders take `&ToolCaps` today, so the registry is threaded via a
  `CrewRegistry` handle on `ToolCaps` or a process cache read at build time; prefer a `OnceLock`+TTL cache
  mirroring `commands/agent_cmds.rs`'s 30s pattern). Optional `agent` param.
- `chat/dispatch.rs`: `run_task_subagent` resolves the def (prompt body replaces the role `match` when the
  role is a crew agent; allowlist + rounds + model/effort from the def; the pre-tool hook pass carries
  the hook origin `agent:<id>`); generalize `subagent_tool_specs` to take the resolved set;
  `subagent_run_tool_inner` checks the resolved set.
- `chat/tools/mod.rs` + `specs.rs`: optional `ToolCaps.allow: Option<Arc<HashSet<String>>>` terminal filter.
- Generalize the contract test (`dispatch.rs:3280-3305`) to the new invariant + add builtin-parity tests
  (a builtin role's effective set is unchanged and its *composed* prompt — role instruction + cwd line +
  boilerplate — is byte-identical to today's).
- UI: Agents tab shows which agent ran (payload already carries `role`; add `agent_id` to
  `SubagentSpawnPayload` — omitted for builtin/harness runs, matching the existing `model: None` precedent).
- Tests: schema enum contains customs; a crew agent with a 1-tool allowlist gets exactly 1 spec; calling a
  non-allowlisted tool returns the same refusal text; depth stays 1 (`Task` unreachable from any set).

### Phase 2.5 — The user runs one themselves (S–M; the end-to-end user story)
- `db/mod.rs`: `migrate_chat_session_agent_def` — `agent_def_id TEXT REFERENCES crew_agents(id) ON
  DELETE SET NULL` (C.3: the `origin` vocabulary stays intact).
- `session_fabric/mod.rs`: `pub fn crew_spawn(app, db, agent_id, prompt, project_id, mode)` — resolve
  the def → **builtin credential pre-flight** (one clear error if the provider key/model is missing)
  → guard (per-agent `max_concurrent` + `CREW_RUNNING` set) → create the child row with the def's
  engine/model/policies/effort + `agent_def_id` (origin left NULL — a human-initiated run) → optional
  worktree → dispatch the first turn via the `run_turn` primitives with a plain task envelope;
  returns the new session id. Reused by the mesh param below, which sets
  `origin = "spawned_by:<parent>"` on top.
- `commands/worktree_cmds.rs`: extract the ensure-logic to take an explicit branch name
  (`relay/<agent-slug>-<id8>`) so both the manual and mesh seams share it; non-git project → project root
  with a `substitution_note` in the run's first system line.
- `commands/crew_cmds.rs`: `crew_spawn_run` Tauri command (the mesh has zero commands today, so this is
  the UI's only door); `SessionSpawnPayload.parent_session_id` → `Option<String>` + a `meshSlice`
  null-parent branch so the sidebar lists the run live (C.5 item 3).
- UI: `crew` view (`state/ui.ts:17` + `App.tsx:489` branch) — list + editor + "Run" modal (task text,
  project picker, wait/background); the run opens as a normal streaming chat tagged with the agent.
- Tests: row carries the def's policies + `agent_def_id`; `spawn_depth` for a manual run is 0 and the
  “spawned” flag stays off (origin untouched); worktree created (temp git repo fixture) + non-git
  fallback; `max_concurrent` enforced; a missing provider key fails before the row is created; the
  mesh's per-parent counter is NOT consumed by manual runs.

### Phase 3 — Session Mesh fan-out: models can call crew agents too (M)
- `session_fabric/mod.rs`: `agent` param on `spawn_session`; child row inherits engine/model/policies/
  effort from the def through the same `crew_spawn` core; the mesh's `MAX_CHILDREN_PER_PARENT`/
  `MAX_ACTIVE_SPAWNED` caps keep governing *model* fan-out while crew-run accounting stays separate;
  `SessionSpawnPayload` gains `agent_id` so the bridge/static fallback schemas mirror it (C.2).
- Schema + static-fallback parity for the new param (`specs.rs:1574` + `relay_browser_mcp.rs`), with a
  param assertion added to the static-cover test.
- Tests: mesh spawn applies the def; harness/builtin tiers behave per C.2; `agent` is accepted (and
  ignored with a note) for an unknown name rather than failing the call.

### Phase 4 — Advisory-tier enforcement: origin-scoped hooks (M)
- `hooks.rs`: `origins: Vec<String>` on `HookDef` (default all; Claude-import stays global);
  filters at `:869`/`:1011`; origin strings carry the agent slug; HooksPanel UI (one multi-select).
- Contract test: an origin-scoped deny fires for its agent and not for the main loop.
- CrewPanel: the tier badges from C.1 + a one-click "guard this agent" hook template.

### Phase 5 — Automations, .md round-trip, run history (M)
- `agent:<id>` in the automation engine validator + `execute` routing; worktree policy honored;
  unattended rules unchanged.
- Export/import `.md` with Claude-Code-compatible frontmatter (`name`, `description`, `tools`, `model`)
  + relay extensions (`sandbox_policy`, `approval_policy`, `worktree_policy`, `engine`, `max_rounds`);
  import validates names/tool names (unknown tool → import error, never a silent drop — the lesson of
  the capabilities-parity work).
- `agent_runs` table + runs view; optional worktree prune policy (age + clean-tree check only).

### Gates per phase
`cargo clippy --workspace --all-targets -- -D warnings` · `cargo test --lib` · `npx tsc --noEmit` ·
`npx vitest run` — plus new tests: allowlist resolution matrix, builtin-parity fixtures, schema-enum
contents, worktree fixtures on a temp repo, budget counters, hooks origin scoping, .md round-trip.

---

## Part E — Open questions

1. **Registry cache vs per-turn reads** — a settings-style TTL cache (30s) keeps hot-path spec builds
   cheap, but a just-created agent is invisible for up to 30s. Invalidate-on-write (the hooks
   `invalidate_config_cache` precedent) fixes it: same pattern.
2. **Crew spawn budget sharing** — should crew runs count against `MAX_ACTIVE_SPAWNED=8` app-wide? Lean:
   no (they're budgeted separately), but a runaway automation could then stack runs — the Phase 5 prune
   and the `max_concurrent` defaults are the safety valve. Confirm before building Phase 3.
3. **Auto-delegation by description** (Claude Code's model-picks-the-agent) — tempting but it makes spawn
   cost nondeterministic; v1 is explicit-only, with descriptions shown in the Task enum's tool docs.
4. **Effort on builtin agents** — `effort` maps to the provider request; verify each provider honors it
   before exposing the field (same verification the live-catalog work did for omp costs).
5. **Sidecar parity** — crew *sessions* need AppHandle; the run-while-closed sidecar keeps running
   engine-level agent prompts only. If Phase 5 wants full parity, the sidecar would need the spawn path
   linked without Tauri state — an honest follow-up, not a v1 promise.
6. **Where crew runs are visible** — a crew run is a normal session, so it shows in the sidebar and
   chat but NOT in the Agents tool panel, which renders `SubagentInfo` (in-session Task runs,
   `meshSlice.ts:16-63`). Should the Agents panel gain a “Crew runs” list reading sessions by
   `agent_def_id` instead of streaming events — and should automation-driven agent runs land there
   too? Leaning yes in Phase 5, once run history exists.
7. **Editing a live agent's model/engine** — a builtin agent re-pointed at another provider leaves its
   historical sessions pointing at the old engine/model columns (the def is a pointer, not a
   snapshot). Acceptable if the UI shows the engine/model on the session row (it already does) —
   confirm before Phase 2.5.

---

## Part F — Implementation contract (binding for every build wave)

Everything below is **binding**: parallel agents build against it so their halves compose. Anything not
listed here is the implementing agent's judgment. Conventions: Rust DB structs serialize
`#[serde(rename_all = "camelCase")]` (mirroring `db::Automation` → the TS `Automation` interface);
Tauri commands take an `*Input` struct and return the row; IPC wrappers go in `src/lib/ipc/<domain>.ts`
and are re-exported from `ipc.ts`; zustand slices mirror `state/automations.ts`. No new crates.

### F.1 DDL (exact)

```sql
CREATE TABLE IF NOT EXISTS crew_agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description     TEXT NOT NULL DEFAULT '',
  prompt_md       TEXT NOT NULL DEFAULT '',
  tools           TEXT,
  engine          TEXT,
  model           TEXT,
  effort          TEXT,
  sandbox_policy  TEXT NOT NULL DEFAULT 'read_only',
  approval_policy TEXT NOT NULL DEFAULT 'on_request',
  worktree_policy TEXT NOT NULL DEFAULT 'inherit',
  max_rounds      INTEGER NOT NULL DEFAULT 100,
  max_concurrent  INTEGER NOT NULL DEFAULT 2,
  builtin         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Phase 2.5, its own migrate_* helper (nullable column, so the FK clause is legal):
ALTER TABLE chat_sessions ADD COLUMN agent_def_id TEXT REFERENCES crew_agents(id) ON DELETE SET NULL;

-- Phase 5 run history (one row per spawned run, not per turn):
CREATE TABLE IF NOT EXISTS crew_runs (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT,                       -- no FK: history outlives a deleted agent
  session_id   TEXT,                       -- no FK: a deleted chat keeps its history row
  trigger      TEXT NOT NULL,              -- 'manual' | 'task' | 'mesh' | 'automation'
  task         TEXT NOT NULL,
  engine       TEXT NOT NULL,
  model        TEXT NOT NULL,
  worktree     TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT NOT NULL DEFAULT 'running',  -- running | ok | error | cancelled
  summary      TEXT
);
```

Migrations follow `db/mod.rs`'s pattern: `init_schema` batch entry for new tables; idempotent
`migrate_*` helpers (swallow `duplicate column name`) called in order after `init_schema`; the builtin
seed is idempotent via `INSERT OR IGNORE` **plus** an `app_settings` marker key `crew.seed.v1` (the
B-30 one-shot-backfill pattern, `db/mod.rs:532-539`).

### F.2 Rust types (exact field names)

```rust
// src-tauri/src/chat/crew.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrewAgent {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt_md: String,
    pub tools: Option<String>,          // JSON array of tool names; None = engine default
    pub engine: Option<String>,         // builtin | local | harness:<id> | acp:<id>; None = inherit
    pub model: Option<String>,          // "model" | "provider::model" | "engine::model"
    pub effort: Option<String>,
    pub sandbox_policy: String,         // read_only | workspace_write
    pub approval_policy: String,        // on_request | auto_edit | full_access
    pub worktree_policy: String,        // inherit | always | never
    pub max_rounds: i64,                // 1..=100 (SUBAGENT_MAX_ROUNDS is the ceiling)
    pub max_concurrent: i64,            // >= 1
    pub builtin: bool,
    pub created_at: i64,
    pub updated_at: i64,
}
// CrewAgentInput = same minus id/builtin/created_at/updated_at; all fields defaulted so the UI can
// send a partial form.

/// The 7 builtin roles live HERE, as data: dispatch.rs's role `match` is replaced by a lookup
/// against this table, so the seed and the runtime can never disagree.
pub const BUILTIN_ROLES: [BuiltinRole; 7] = [ /* names + the instruction strings copied VERBATIM
                                                from dispatch.rs:988-996 */ ];
pub fn builtin_role_instruction(role: &str) -> Option<&'static str>;
pub fn resolve_allowlist(conn: &Connection, def: Option<&CrewAgent>) -> Option<Arc<HashSet<String>>>;
pub fn list(conn) -> Vec<CrewAgent>;  pub fn get(conn, id) -> Option<CrewAgent>;
pub fn create(conn, input) -> Result<CrewAgent, String>;
pub fn update(conn, id, input) -> Result<CrewAgent, String>;
pub fn delete(conn, id) -> Result<(), String>;  // refuses builtin=1 and live runs
pub fn running_set() -> &'static Mutex<HashMap<String, i64>>;  // agent_id -> live count
```

Name rules: 1–48 chars, `[a-z0-9-]` + spaces allowed but normalized to `-` for ids, must not collide
with a builtin role name (those are reserved); description ≤ 200 chars.

### F.3 Tauri commands (exact names — CONTRACT.md-binding)

```
list_crew_agents()                                  -> Vec<CrewAgent>
get_crew_agent(agent_id: String)                    -> Option<CrewAgent>
create_crew_agent(input: CrewAgentInput)            -> CrewAgent
update_crew_agent(agent_id: String, input: CrewAgentInput) -> CrewAgent
delete_crew_agent(agent_id: String)                 -> ()
run_crew_agent(agent_id: String, task: String, project_id: Option<String>, wait: Option<bool>) -> String
                                                       // returns the new chat_session_id
export_crew_agents(agent_ids: Option<Vec<String>>)  -> String   // concatenated .md docs
import_crew_agent(markdown: String)                 -> CrewAgent  // strict: unknown tool/name = Err
list_crew_runs(agent_id: Option<String>, limit: Option<i64>) -> Vec<CrewAgentRun>
```
Registered in `lib.rs` next to the automations block. `run_crew_agent` is the ONLY UI spawn door
(the mesh has zero commands today).

### F.4 TS types (exact)

```ts
// src/lib/ipc/crew.ts — mirrors CrewAgent 1:1 (camelCase)
export interface CrewAgent {
  id: string; name: string; description: string; promptMd: string;
  tools: string[] | null;           // parsed from the JSON column; null = engine default
  engine: string | null; model: string | null; effort: string | null;
  sandboxPolicy: string; approvalPolicy: string; worktreePolicy: string;
  maxRounds: number; maxConcurrent: number; builtin: boolean;
  createdAt: number; updatedAt: number;
}
export interface CrewAgentRun { id: string; agentId: string | null; sessionId: string | null;
  trigger: string; task: string; engine: string; model: string; worktree: string | null;
  startedAt: number; finishedAt: number | null; status: string; summary: string | null; }
// wrappers: listCrewAgents, getCrewAgent, createCrewAgent, updateCrewAgent, deleteCrewAgent,
// runCrewAgent, exportCrewAgents, importCrewAgent, listCrewRuns (all safeInvoke)
```

### F.5 Event + tool-param changes (binding across waves)

- `SessionSpawnPayload` (`types.rs:665-673`): `parent_session_id: Option<String>` with
  `#[serde(default, skip_serializing_if = "Option::is_none")]` + new
  `agent_id: Option<String>` (same serde). TS: `parentSessionId?: string; agentId?: string`.
  `meshSlice.onSessionSpawn`: `parentSessionId == null` → NOT a mesh child; record it in the crew
  slice's `runs` map and refresh the session list. Non-null keeps today's behavior byte-for-byte.
- `SubagentSpawnPayload` (`types.rs:1204`): add `agent_id: Option<String>` (same serde) + TS
  `agentId?: string` in `ipc/harnessChat.ts`'s `SubagentInfo`. Omitted for builtin-role and
  harness-native runs.
- `Task` tool: new optional `agent` (string — crew agent id or name). `subagent_type`'s enum stays
  **dynamic**: the 7 builtin names are ALWAYS present, plus every crew agent name, rebuilt per turn
  from the registry cache (30s TTL, invalidate-on-write via the hooks `invalidate_config_cache`
  pattern, `hooks.rs`). The schema gains `agent` in `task_parameters()`; the enum lives in the
  parameter builder, which must take the name list as an argument.
- `spawn_session`: new optional `agent` (string) in `spawn_session_parameters()` AND in the static
  fallback schema in `bin/relay_browser_mcp.rs`; the static-cover test gains a **param** assertion
  (today it only pins names).
- Hooks: `HookDef.origins: Vec<String>` (`#[serde(default)]`, empty = all origins); the filter
  predicates at `hooks.rs:869`/`:1011` gain `origins.is_empty() || origins.iter().any(|o| o == origin)`.
  Origin strings: main chat `"chat"` (unchanged), builtin-role Task `"subagent"` (unchanged),
  crew Task `"agent:<id>"`, manual/mesh crew runs `"agent:<id>"`, harness `"harness"`, bridge
  `"relay_tools"` (unchanged).
- Automations: `automation.harness` additionally accepts `agent:<id>` — extend the validator with a
  **predicate** (resolve the id), not by growing the `ALLOWED_AGENTS` const. `execute` resolves the
  agent's engine first, then takes today's two arms unchanged.

### F.6 `.md` interchange (Phase 5)

```markdown
---
name: doc-writer
description: Writes and polishes user documentation
tools: [read_file, list_directory, write_file]
model: openrouter::x-ai/grok-4
engine: builtin            # relay extension
sandbox_policy: workspace_write
approval_policy: on_request
worktree_policy: always
max_rounds: 40
---
Body = the system prompt (prompt_md).
```
Unknown `name` format, unknown tool, or non-frontmatter input → hard `Err` (never a silent drop).

### F.7 Build waves + file ownership (collision-free)

| Wave | Agent | Owns (may edit ONLY these) |
|---|---|---|
| 1 | P1-backend | `db/mod.rs`, `db/crew.rs`(new), `chat/crew.rs`(new), `chat/dispatch.rs` (role lookup only), `commands/crew_cmds.rs`(new), `lib.rs`, `db/session_fabric.rs` |
| 1 | P1-frontend | `src/lib/ipc/crew.ts`(new), `src/lib/ipc.ts`, `src/state/crew.ts`(new), `src/components/crew/CrewPanel.tsx`(new), `src/components/settings/SettingsView.tsx`, `src/test/crew*.test.*`(new) |
| 2 | P2-backend | `chat/dispatch.rs`, `chat/tools/mod.rs`, `chat/tools/specs.rs`, `chat/subagent_model.rs`, `types.rs` |
| 3 | P2.5+3-backend | `session_fabric/mod.rs`, `db/mod.rs` (agent_def_id only), `commands/worktree_cmds.rs`, `commands/crew_cmds.rs`, `types.rs`, `chat/tools/specs.rs`, `bin/relay_browser_mcp.rs` |
| 3 | P2.5+3-frontend | `src/state/ui.ts`, `src/App.tsx`, `src/state/chat/slices/meshSlice.ts`, `src/lib/ipc/sessionMesh.ts`, `src/components/crew/*`(new), `src/lib/ipc/chatSessions.ts`, `src/components/chat/ChatSessionRow.tsx`, `src/hooks/useChatEvents.ts` |
| 4 | P4-hooks | `hooks.rs`, `commands/hooks_cmds.rs`, `src/lib/ipc/hooks.ts`, `src/components/settings/HooksPanel.tsx`, `chat/dispatch.rs` (origin only) |
| 5 | P5-automation+md | `automations.rs`, `commands/automation_cmds.rs`, `chat/tools/automations.rs`, `chat/tools/specs.rs`, `chat/crew.rs`, `commands/crew_cmds.rs`, `src/lib/ipc/automations.ts`, `src/components/automations/*`, `db/mod.rs` (crew_runs) |

Rust waves are sequential (cargo target lock); frontend agents may overlap a Rust wave (tsc/vitest
have no shared lock). Every agent runs `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo test --lib` (or the targeted module filter) and `npx tsc --noEmit` + its vitest files, and
reports verbatim output.
