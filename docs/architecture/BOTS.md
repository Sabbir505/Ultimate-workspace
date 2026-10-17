# Bots — named persistent agents

**Status:** Shipped (Unreleased, 2026-10-15). Living doc — update when the feature changes.
**Plan:** `docs/research/2026-10-04-bots-always-on-agents.md` (Revision 2). This document describes what actually shipped, including the deliberate deviations listed at the end.

## What a bot is

A bot is a persisted **identity**, not a chat:

| Field | Meaning |
|---|---|
| `name` | Trimmed, whitespace-collapsed, 1–40 chars, unique ignoring case. The thread title follows a rename (`update_bot` re-titles `bot_role = 'thread'` sessions). |
| `description` | One line for the rail and the mobile screen. |
| `emoji`, `color`, `pet` | Identity chrome. `pet` is one of the six docked companions (`cat`, `fox`, `panda`, `dragon`, `axolotl`, `robot`) or `""` for none. |
| `system_prompt` | The persona. It **layers on** the user's global assistant prompt unless `inherit_global_prompt = false`. An identity line (**Revision 3**: the bot's name, its purpose, and that it is a scheduled bot with its own memory) is always layered under the persona, so even a bot with no custom persona knows it is a bot instead of behaving like the plain assistant. |
| `provider`, `model` | A pinned engine. Empty = the bot inherits: its sessions start on `("auto", "auto")` and the send path resolves a concrete provider exactly as a fresh Auto chat does. |
| `tools_enabled` | `false` → the bot's turns (thread **and** runs) are assembled with an **empty tool set**: chat only. |
| `memory_enabled` | `false` → its turns are never extracted into memory, and `memory_recall`/`memory_save`/`memory_forget` refuse. |
| `enabled` | `false` → standing jobs are skipped and `run_bot`/`ask_bot` refuse; **the thread stays usable**, so an agent-created bot can be reviewed before it is approved. |
| `inherit_global_prompt` | `true` (default): `compose_prompt` = global + `---` + persona. `false`: persona only. |
| `memory_read_default` | `true` → recall may also read the user's `default` memories. **Writes never cross namespaces.** |

Every other reference to a bot — approvals, runs, jobs, the memory profile, the mobile frames — is by **id, never by name**, so a rename can never orphan anything. The single "no bot" sentinel is **NULL**.

## Sessions: the thread vs. a run

`chat_sessions.bot_id` binds a session to a bot; `bot_role` says which kind it is:

- **`'thread'`** — one of the bot's conversations. `ensure_bot_session` returns the newest thread (creating one lazily on first use) and only ever a thread: run sessions share `bot_id` and must never become "the thread". A bot may hold **several** conversations — the Sessions rail's **＋ New** button (`new_bot_session` → `create_bot_thread_session`) adds one; the newly created one becomes the bot's default (newest wins, rowid tie-broken because `created_at` is second-granular). Each opens with the same `ChatView`, reached from the Bots view rail.
- **`'run'`** — one headless execution (a standing job, `run_bot`, `ask_bot`). Opened from the bot's **Recent runs** strip, where the real `ChatView` renders their transcript. Runs are deliberately **not** listed in the rail's Sessions section (that section is the bot's conversations); showing both made a single `ask_bot` look like it spawned two chats. **While a run is in flight, opening the bot (rail row or docked pet) or pressing "Run now" opens that LIVE run** so the center shows it streaming instead of the idle thread.

**No bot session appears in Chat History**: both the flat inbox and the projects list filter out any session with a `bot_id` (thread or run). The Bots view rail is the bot's home — the active bot's **conversations** are listed in a **Sessions** section below the roster (pinned first then newest), with a **＋ New** button to start another; runs are kept to the Recent runs strip. A `delete_bot` unbinds every conversation, each of which then reappears as an ordinary chat.

`bot_job_id` records the automation that spawned a run.

Because persona and memory both key off `bot_id`, a run gets both for free — no extra plumbing, and the user's conversation is never touched by background work.

After a run finishes (success, failure or cancel) **one** compact assistant message is posted into the thread (`⚙ **emoji** job — status · excerpt`), so the conversation stays a conversation while the transcript lives in the run session. Runs are pruned to the newest 50 per bot (sessions, approvals and `bot_runs` rows together).

## Unattended permissions (the important part)

A background run never executes a write-class tool.

- `chat::bot_policy::is_write_class` borrows the plan gate's mutation list (`plan::is_mutating_tool`): filesystem writes, `run_shell`/`run_code`, automation/subagent authoring, Session Mesh writes, vault writes, the mutating browser ops, Relay self-control. **Memory writes are deliberately NOT write-class** — a bot's `memory_save`/`memory_forget` can only reach its own profile, and queueing them would make standing jobs unable to remember anything.
- The gate is hooked at the top of `dispatch::run_tool`, keyed on `bot_role = 'run'`. On a write-class call it inserts a `bot_approvals` row and returns a synthetic tool result: *"Queued for the owner's approval (id …). This action has NOT run … Do not retry it."* The model finishes its remaining reads instead of looping on a refusal.
- `summary` is built **deterministically** from the tool name + declared arguments (`summarize_tool_call`) — never model-written text, so a prompt-injected run cannot disguise what it is asking for.
- Pending rows **expire after 72 hours** (swept on every list and at start): a stale approval is a hazard, not a convenience.
- Resolution: `resolve_bot_approval(id, approve)`. **Approve replays the stored args verbatim** through the same family executor the live dispatcher would have used (automations / subagents / vault / bots call their executors directly; everything else goes through `tools::execute_tool`). The dispatcher is deliberately not re-entered — its own cards need a paused live turn that no longer exists. Deny writes the row off. Either way a `✓ Approved: …` / `✕ Denied: …` note lands in the run session so its history stays truthful.
- A queued call emits `bots:changed {action:"approval"}` and pushes "«Bot» wants your approval: …" to the phone.

**Preflight finding (recorded here as the plan asked):** today's headless tool-less path is `run_one_shot_chat` (automations with API/local engines) — it genuinely cannot call tools at all, so there was nothing to auto-allow or hang there. The CLI-harness one-shot path (`agent_sessions::run_one_shot`) runs with `--dangerously-skip-permissions` and cannot be intercepted mid-flight; bot runs therefore take the API path with a real tool loop (`chat::run_bot_one_shot`), where the gate above is authoritative. A bot run launched by the headless `relay-automation` binary has no `AppHandle` (so no tool loop) and falls back to the persona-correct one-shot — no tools, no writes, nothing unattended to approve.

## Memory scoping

- The memory subsystem's existing `memories.profile` column carries `bot:<id>`: no schema change, and every existing SQL statement keeps its single-profile shape.
- **Writes** (extraction, `memory_save`, `memory_forget`) use the session's own profile. `memory_forget` refuses a row whose profile is not the session's own — not even when read-through recall showed the id.
- **Reads** (`memory_recall`) query the session's own profile plus `default` when `memory_read_default` is on, merging the two ranked lists.
- The **memory document** (`memory.document`, the user's one-page memory) is only ever rewritten by `default`-profile extraction; a bot's merge never touches it, and `memory_forget` only clears it for its own profile.
- The editor's Memory section lists and deletes a bot's memories through `bot_memory_list` / `bot_memory_delete`; the delete refuses any row that is not exactly `bot:<bot_id>`.

## Standing jobs

`automations.bot_id` makes an automation a bot's standing job (no FK: `delete_bot` deletes bound jobs inside its transaction, and a dangling job must never fire).

- `prepare_run` short-circuits for bot jobs: a disabled bot is skipped (status `skipped`, logged), and an enabled one gets a **fresh run session** (`bot_runs::start_bot_run` → `bot_runs` row + `bot_role='run'` session) instead of the automation's own run log. The automation's `chat_session_id` is re-pointed at that run session so "open run log" and the empty-session sweeper keep working.
- `execute` dispatches bot jobs to `chat::run_bot_one_shot` (tools + gate) when an `AppHandle` exists, and to `run_one_shot_chat` (persona, no tools) from the headless binary.
- `finalize` closes the `bot_runs` row and posts the thread summary.
- The Automations editor has a **"Standing job of"** picker (create **and** edit; a bound job's `bot_id` is rebindable, and `""` unbinds). The Bots view's **Add job** opens that form pre-bound to the selected bot; the Automations view remains the deep management surface. Both the Bots view's job strip and the editor read the same rows.

## Surfaces

- **Bots view** (`ActiveView = "bots"`, sidebar pill next to Automations/Vault/Wiki): the rail is split in two — the **bot roster** on top (pet, name, description, gold pending-approval count, inline rename on double-click, `Approve` on a disabled row) and, below it, a **Sessions** section listing the active bot's **conversations** (pinned first then newest, same per-row **pin/delete** actions, plus a **New Chat** icon that starts another), styled like the main chat list. The center mounts **the real `ChatView`** on the selected session, plus a right-hand **activity rail** (`.bots-sidebar`, in place of the git tools sidebar): approval inbox, standing jobs (**Add job** hands off to the Automations editor bound to this bot), recent runs (the open run highlights; a **live** run shows a **Stop**), and an **Output** section (files the bot produced across its conversations and runs). The activity rail **collapses to a thin chip** (carrying a pending-approval badge) with the same affordance as the main chat's Git tools sidebar — `botsActivityCollapsed` in the ui store, ephemeral like the git one — and the conversation/composer reclaim its gutter. No bespoke message renderer anywhere. Session titles carry no emoji prefix (a conversation is the bot's plain name; a run is its job name).
- **BotEditorModal** — the only editor (no Settings page): name, description, pet picker with live 3D previews, emoji, dot color, persona, five toggles (**Active**, Allow tools, Memory, Use my global instructions, Can read my memory), Memory section, and a delete confirmation that states the effect before it happens (jobs removed, conversation kept, memories exported to a Vault note and purged only if the checkbox is ticked). Saves send **only changed fields** (patch semantics), so an edit can never blank a field the form does not carry. The agent's `update_bot` can never set `enabled` — the **Active** toggle is the owner's, and it is the only place a bot is enabled/disabled.
- **Docked pets** (`src/components/pet/BotPetDock`): one pet per bot that chose one, docked on the **composer** and above the **search bar** — the two homes the classic companion used. Clicking a pet opens that bot's thread and switches to the Bots view. The pet's animation is the bot's state: working while a run is in flight, sleeping while the bot is disabled, strolling while an approval waits. The full-screen **wiki / vault** views hide every dock; the **Bots view keeps its composer dock but shows ONLY the selected bot's pet** (the selected id lives in the ui store). With no bot pets docked, the classic companion strip renders in the same slot (unchanged behavior).
- **Main-chat tools** (`list_bots`, `create_bot`, `update_bot`, `delete_bot`, `run_bot`, `ask_bot`): reads and `ask_bot` are always available; the CRUD/run half is **mutating-gated and family-locked** (`attach_connector("bots")` or the "bot/persona/standing job" keyword fast-path), exactly like automations. Agent-created bots land **disabled**; agent-origin updates **drop `enabled`** (enabling is the owner's action); the agent-facing delete always keeps memories. These tools are **excluded from the harness relay bridge** — a harness CLI has no live turn to carry an approval card.
- **Mobile** (`BotsScreen`, reached from **Settings → Manage → Bots**): the phone's approvals console — pending rows with summary/tool/arguments and Approve/Deny (resolved through the same command as the desktop), plus the bot roster with dot state, job count and pet. Relay frames: `ListBots` → `BotsList`, `ListBotApprovals` → `BotApprovalsList`, `ResolveBotApproval` → `BotApprovalResolved`. (Bot creation and enable/disable stay desktop-only.)
- **Usage page** (`CostDashboard`): a **Bots** section (`get_bot_costs` → `db::bots::bot_cost_rollups`) lists each bot's spend in the selected range — the sum over EVERY session bound to it (conversations **and** runs) from `chat_messages`, plus run/job counts and a range total. Dearest first; renders nothing until a bot exists.
- **Returning to Chat**: the Bots view renders the real `ChatView` on a bot session, which shares the one `activeChatSessionId`. Bot sessions therefore select with `recordNav: false` (they never enter the main chat's Back/Forward timeline), and `useMainChatRestore` hands the main chat its own session back the moment the Bots view stops being the base view — reselecting the last non-bot chat, or starting a fresh composer-seeded chat when there is none. Without it, toggling Bots→Chat (the bottom-bar button selects no chat) left the bot session showing in the main Chat view.
- **Events**: `bots:changed {action: "created"|"updated"|"deleted"|"run"|"approval", botId}` drives every surface's refresh (one shared listener, wired in `useBotEvents`, plus the `botsRunning` poll — not one listener per consumer). A finished manual/`ask_bot` run also emits `bot:run-finished`, which `useBotEvents` funnels through `relayNotify`: the bell always records it and a failure raises an OS toast + chime (scheduled jobs already notify through `automation:run-finished`).

## Scheduler honesty

`scheduler_available()` is true only where run-while-closed is registered — Windows, via the `RelayAutomations` Task Scheduler entry (`relay-automation run-due`). Everywhere else the Bots view says "standing jobs run while Relay is open", and copy says **standing jobs**, never "always-on". launchd/systemd parity and a Background/Interactive local-model queue priority remain follow-ups.

## Deliberate deviations from the plan

- **Pets replaced the 2D sprite sheets.** The plan's v1 shipped an emoji dot; the user's direction was the six 3D pets from `docs/research/ade-pets`, so `src/lib/pets/adePets.ts` (one shared WebGL stage, dynamically imported, `three` as a new dependency) renders the companion and the docked bot pets. The sprite renderer remains as the fallback for jsdom/no-WebGL, and the three sheetless species draw an emoji chip there. Hats are a sprite cosmetic and therefore render in the fallback only.
- **`bots_write` is a family flag.** Without it the bots write specs would ride every default turn; the plan's "may be family-locked" reading of the automations precedent was taken.
- **`bot_runs` table.** The plan derived run state from `automation_runs`; jobs started by `run_bot`/`ask_bot` have no automation, so runs have their own row (status, timing, source, summary) and pruning keys off it.
- **Run sessions are deleted with their bot** (threads are unbound and kept): unbinding runs would leak dozens of "⚙ job · timestamp" rows into Chat History.
- **The memory document is not per-bot** (single global artifact, per the pre-existing design); bots neither write nor inject it.

## Non-goals

No per-bot sandboxed computer, no connector directory, no Settings-page editor, no bot-created bots, no per-bot tool allowlists beyond the tools on/off switch.
