# Bots (Persistent Local Agents) — Implementation Plan

> **Revision 2 (2026-10-14):** amended after design review — see "Revision 2: review findings" below. Unattended-run permissions, per-run sessions, delete semantics, memory visibility and read-through, persona layering, toggle semantics and the harness bridge are now specified. Tasks 1–12 are amended in place (search for **Revision 2**); Tasks 13–17 are new. **"Bots" is a working name** — see "Naming (open decision)"; resolve it before Task 1.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named persistent agents ("Bots") — each with its own persona, memory scope, standing jobs, and its own conversation — surfaced as a first-class **Bots view** (like Vault/Automations/Wiki) with a bot rail on the left and the real ChatView in the center, plus chat tools (`list_bots`, `create_bot`, `update_bot`, `run_bot`) so the main chat can manage bots conversationally.

**Architecture:** A `bots` SQLite table holds the agent identity (name, emoji, description, persona prompt, model, toggles). Each bot owns one lazily-created chat session (`chat_sessions.bot_id`, `bot_role = 'thread'`) — its thread; each standing-job run gets its own `bot_role = 'run'` session. The Bots view mounts the **real `ChatView`** bound to the bot's session (same store, same pane component — no bespoke renderer), so bot threads are also openable from normal chat history. Bot memory reuses the memory `profile` namespace as `bot:<id>`. `automations.bot_id` turns a trigger into a bot's standing job. Agent-facing chat tools mirror the automations tool family, with write tools landing disabled pending approval. There is **no Settings page for bots** — the editor is a modal opened from the Bots view.

**Tech Stack:** Rust/Tauri (rusqlite, existing automations scheduler + memory worker + tool registry), TypeScript/React (existing view/view-nav patterns, `ChatView` main-pane reuse), Vitest (frontend), `#[cfg(test)]` rusqlite tests (backend).

**Spec:** Design rationale in the "Design" section below; visual spec at `docs/superpowers/specs/2026-10-04-bots-design-mockup.html` (open in a browser — Surface 01 is the Bots view, Surface 02 the empty state + create modal, Surface 03 the main-chat tools, Surface 04 mobile).

## Revision 2: review findings (2026-10-14)

A design review of this plan against the shipped Relay surface (Automations, Session Mesh, memory profiles, mobile relay) and the current always-on-agent market found the holes below. Each has a decision and a task. Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 12 are amended in place (look for **Revision 2** markers); Tasks 13–17 are new. Task numbers are stable on purpose, so existing cross-references still resolve.

| # | Finding | Decision | Lands in |
|---|---|---|---|
| 1 | **Unattended permissions undefined.** Bot jobs run headless through `run_one_shot_chat`; nothing says what happens when a write-class tool needs approval and nobody is there. Webhook and Gmail triggers make the input untrusted. | Background runs never execute write-class tools. They queue a `bot_approvals` row (deterministic one-line summary, not model-written), notify desktop and phone, and the owner approves or denies. Read-class tools run. | 13 (+9, 10, 11) |
| 2 | **"Always-on" overclaims.** Run-while-closed exists only through the Windows Task Scheduler sidecar; on macOS and Linux jobs run only while Relay is open. A cron job on the single local model can also block interactive chat. | Copy says "standing jobs". The Bots view shows "Runs only while Relay is open" where no scheduler is registered. Interactive turns outrank background runs on the local-model queue. launchd/systemd parity is a P2 task. | 17 |
| 3 | **Dead toggles.** `tools_enabled` sat in the schema, struct, modal and tests but was enforced nowhere; `enabled` was undefined for the interactive thread. | `tools_enabled = false` means the bot's turns get an empty tool set. `enabled = false` means jobs are skipped and `run_bot` refuses, while the thread stays usable so an agent-created bot can be reviewed before approval. | 15 (+1, 7) |
| 4 | **One thread for chat and jobs.** Every cron run landed in the conversation the user talks in, and the thread grows without bound. | Thread and runs are separate: `chat_sessions.bot_role` is `thread` or `run`. Each run gets its own session; a one-message summary with an "Open run" link is posted to the thread. Run sessions are hidden from Chat History and pruned (newest 50 per bot). | 1, 3, 9, 14 |
| 5 | **Delete leaves orphans.** `ON DELETE SET NULL` turned the thread into a plain chat that wrote to `default` memory; `bot:<id>` memories became unreachable; `automations.bot_id` had no FK so jobs dangled; NULL and the empty string both meant "no bot". | Transactional delete: remove bound jobs, unbind sessions explicitly (no reliance on `PRAGMA foreign_keys`), freeze their memory cursors, optionally export then purge `bot:<id>` memories. One sentinel: NULL. | 1, 2, 8 |
| 6 | **Bot memory invisible and fully isolated.** MemoryPanel reads `default` only, so the owner can't see or delete what a bot remembers; a bot also knew nothing about its owner. | Bot memory is viewable and deletable from the editor. New per-bot `memory_read_default` (default off): recall reads own plus `default`; writes always go to the bot's own profile. | 5, 8 (+1, 2) |
| 7 | **Persona replaced the global prompt**, dropping the user's standing instructions (language, tone, rules). | Persona layers on top of the global prompt. Per-bot `inherit_global_prompt` (default on) turns that off. Non-bot sessions get the global prompt back unchanged by construction. | 4 (+1, 8) |
| 8 | **Bots can't touch the harness.** Bots were chat-only, disconnected from the CLI agent panes that are Relay's actual differentiator. | `ask_bot` is promoted out of follow-ups; bots get Session Mesh access, with agent spawning treated as a write-class action that queues for approval in background runs. | 16 |
| 9 | **Market facts were off.** Grok Bot's beta was Aug 11 (SpaceXAI), not September; "$100/mo" is one Muse tier, not the market price. | Design bullet corrected. | Design |
| 10 | **`ensure_bot_session` hard-coded provider `"openai"`**, so a bot with `provider = ""` ("inherit") would inherit OpenAI regardless of the user's setup. *(Found while amending.)* | Seed the new session from the bot's provider/model, else the user's default for new chats. | 1 |
| 11 | **The original Task 4 snippet very likely does not compile**: `?` inside an `.or_else` closure that returns `Option`. *(Found while amending.)* | Replaced by `resolve_custom_prompt`. | 4 |
| 12 | **Anchors drift.** The plan cites about 40 `file:line` positions in a repo with 800+ commits. | Preflight below. | Preflight |
| 13 | **Renaming a bot is half-supported, and `update_bot` is not a patch.** (a) Every field went through `unwrap_or(default)`, so a rename-only call (the editor, or the agent's `update_bot` tool) blanked the persona and description and set `enabled = true`, which would let an agent re-enable a bot and bypass "agent-created bots land disabled". (b) The thread title (`"{emoji} {name}"`) was written once at creation and went stale after a rename. (c) No name validation or uniqueness, so duplicate names make `list_bots`, approval summaries and mobile ambiguous. *(Found on follow-up.)* | `update_bot` becomes a **patch** (`BotPatch`): only fields that are `Some` change. Names are trimmed, whitespace-collapsed, 1–40 chars, unique case-insensitively (pre-check for a friendly error plus a unique index as the race backstop). A rename or emoji change updates the thread title. Agent-origin updates cannot set `enabled`. Inline rename in the rail. Everything else refers to a bot by id, never by name. | 1, 2, 6, 7, 8, 10, 13 |

### Revised build order

Build a thin vertical slice first, so the dangerous part (unattended runs) is designed before the pretty part (rail, modal, mobile).

1. **Slice:** Task 1 → 2 → 3 → 4 → 5 → 9 → 13 → 14. Outcome: one bot with a layered persona, its own memory, and one cron job that runs in its own session with read-only tools, queues approvals, and posts a summary to the thread. Testable from the Rust side plus a minimal view.
2. **Surface:** Task 7 → 8 → 15.
3. **Reach:** Task 16 (harness bridge) → 10 (chat tools) → 11 (mobile list and approvals).
4. **Polish:** Task 17 (scheduler parity; the honesty badge in its Step 2 can be pulled forward into Task 7) → 12 (docs last, so they describe what shipped).

### Preflight (before Task 1)

1. **Re-verify anchors.** For every `file:line` cited in this plan, open the file and confirm the surrounding code still matches, and fix the plan, not just your memory. Quick check: `grep -n 'assistant.systemPrompt' src-tauri/src/chat/commands/send.rs src-tauri/src/chat/mod.rs`.
2. **Foreign keys.** `grep -rn 'foreign_keys' src-tauri/src/db/`. Task 1 no longer depends on the answer, but record it in BOTS.md.
3. **Headless tool approval today.** Find how `run_one_shot_chat` treats write-class tools when no UI is listening (auto-allow, auto-deny, or hang). If it auto-allows, report it as an existing gap for non-bot automations in the CHANGELOG, but do not change non-bot behavior in this plan (Global Constraints).
4. **Open audit items.** Skim `docs/audits/BUG_AUDIT.md` for open Sev items in automations, memory or the mobile relay; bots build on all three.
5. **Name.** Resolve the working name (next section) before Task 1.

## Naming (open decision)

**"Bots" is a working name.** "Bots", "Dots" and "Muse" are now the market's vocabulary, so a distinct name helps the feature read as Relay's own. Candidates and their trade-offs:

| Name | Why it fits | Watch out for |
|---|---|---|
| **Runners** | Extends the product name (a relay is run by runners passing a baton) and the existing vocabulary: runs, run now, `run_bot`, standing jobs. | CI "runners" (GitHub Actions) may suggest a build agent; "a runner's runs" is slightly repetitive. |
| **Daemons** | Unix background process: named, persistent, local. Dev-native and honest about what it is. | Demon connotation; less friendly outside a developer audience. |
| **Familiars** | A named companion bonded to you that remembers you. Matches the name + emoji + dot identity. | Whimsical beside a coding shell. |
| **Embers** | A small glow that stays lit; mirrors the pulsing state-dot language and the local, low-power angle. | Implies fading; Ember.js association. |
| **Stewards** | Someone who keeps things running while you're away. Neutral and professional. | Bland; longer in UI copy. |

Recommendation: **Runners**. Not yet checked for trademark or app-store collisions; do that before committing.

**Cost of renaming:** cheap now, expensive after Task 1. Identifiers that embed the name: table `bots`; columns `bot_id`, `bot_role`, `bot_job_id`; modules `db/bots.rs`, `commands/bot_cmds.rs`, `chat/tools/bots.rs`; commands and tools `*_bot*`; event `bots:changed`; `ActiveView` member `"bots"`; `components/bots/`, `bots.css`, `BotsScreen`; relay messages `ListBots` / `BotsList`; docs. **The one that is persisted user data is the memory profile prefix `bot:<id>`**, and renaming it later needs a data migration. Pick the name, then do a single find-and-replace on this document before any code is written.

## Design (why it looks like this)

- **A bot is a named entity, not a chat — but you talk to it in a chat.** Market framing (SpaceXAI Grok Bot beta, Aug 11 2026; Meta Muse, Sept 8; OpenAI Dots, Sept 29): identity + memory + standing jobs + reachable anytime, each on a vendor-hosted cloud computer behind a free tier or paid plan. Relay does not compete on connector count or hosting. Its differentiator is **local and harness-native**: bots run on the user's own machine and (Task 16) can drive Relay's CLI agent panes through Session Mesh, which a hosted agent cannot do against the user's local repos. "Always-on" is literally true only where run-while-closed exists (Windows today), so copy says "standing jobs" (Task 17).
- **The Bots view is a destination, like Vault/Automations/Wiki** (user decision, 2026-10-04): new `ActiveView` member `"bots"`, entry in the sidebar Global Views block, full center-area swap in `App.tsx`. Left rail = roster (dot, emoji/sprite, name, one-line description, live status dot). Center = the bot's conversation.
- **The center IS the real `ChatView`.** `ChatView()` with no props renders the active session from the chat store (`ChatPaneGrid.tsx:76` mounts it exactly this way for the main pane). Selecting a bot in the rail calls `selectSession(botSessionId)` and renders `<ChatView />`. Bot threads therefore get streaming, tools, approvals, artifacts, checkpoints, TTS for free — and remain openable from Chat History like any session. Never build a second message renderer.
- **No settings page.** Creating/editing a bot happens in a `BotEditorModal` opened from the Bots view (empty-state promo card and the "New bot" rail button both open it). The persona **layers on top of** the user's global prompt (Task 4); `inherit_global_prompt = false` opts a bot out.
- **Main chat manages bots via tools**, mirroring `chat/tools/automations.rs`: `list_bots` (read), `create_bot` / `update_bot` / `delete_bot` (write-classified — agent-created bots land `enabled = 0` pending approval, same as agent-created automations), `run_bot` (write-classified — starts a background-origin run session now, Tasks 13–14).
- **Visual identity = the dot.** Bots render as a colored dot + emoji (Relay's state-dot language: `--state-working` teal, `--state-waiting` gold, `--state-idle` gray). The dot pulses while a job runs. Custom sprite images are a follow-up; v1 ships emoji.
- **Background runs are read-only by default, and a run is its own session** (Revision 2). A standing job, `run_bot` or `ask_bot` never executes a write-class tool; it queues an approval the owner resolves from the Bots view or the phone (Task 13). Each run gets a `bot_role = 'run'` session, hidden from Chat History, with a one-message summary posted to the bot's thread (Task 14). The thread stays a conversation.

## Global Constraints

- **No new dependencies** — no new crates in `src-tauri/Cargo.toml`, no new npm packages.
- All new wire types use `#[serde(rename_all = "camelCase")]`; all event payloads use camelCase keys.
- **The Bots view center mounts the real `ChatView`** — no bespoke message list, no forked composer.
- **Non-bot sessions must be unchanged**: when `chat_sessions.bot_id` is NULL, the send path, memory pipeline, and prompt-cache warmup behave exactly as today.
- **No bot CRUD in Settings** — the modal is the only editor.
- Bot memory is a memory `profile` value `bot:<botId>`. The user-facing MemoryPanel defaults to profile `default` and takes an optional `profile` prop so a bot's memories are viewable and deletable from the editor (Task 5). A bot thread **writes** only to its own profile; it **reads** `default` only when `memory_read_default` is on.
- Follow the existing migration pattern (`ALTER TABLE … ADD COLUMN` + swallow "duplicate column name", registered in `db::configure`).
- Windows run-while-closed (`relay-automation run-due` → `run_blocking`) must keep working for bot-bound automations.
- One local model at a time (v1 policy, `local_models.rs`) — bot jobs on LocalGguf share the same sidecar queue as chats, **but interactive turns outrank background bot runs** (Task 17).
- Agent-created bots land **disabled** pending approval (mirror the agent-created-automation behavior in `chat/tools/automations.rs`).
- Copy style: sentence case, active verbs ("New bot", "Run now").
- **Background runs never execute write-class tools** (Task 13). The gate applies only to sessions with a `bot_id`; non-bot sessions never reach it.
- **One "no bot" sentinel: NULL** (`Option<String>` in Rust, `string | null` in TS). No empty-string sentinel anywhere.
- **Deleting a bot is transactional** and leaves no dangling jobs and no live extraction of its old thread into the `default` memory profile (Task 1).
- **Thread vs run:** `ensure_bot_session` only ever returns the `'thread'` session; run sessions share `bot_id` but never become "the thread".
- **Bot names** are trimmed, whitespace-collapsed, 1–40 characters and unique case-insensitively. Every other reference to a bot (approvals, runs, jobs, mobile, memory profile) is by **id, never by name**, so a rename can never orphan anything.
- Copy says **"standing jobs"**, not "always-on", wherever run-while-closed is not registered (Task 17).

## File Structure

| File | Role |
|---|---|
| `src-tauri/src/db/mod.rs` | Modify. `bots` CREATE TABLE in `init_schema`; `migrate_chat_sessions_bot_id`, `migrate_automations_bot_id` in `configure` |
| `src-tauri/src/db/bots.rs` | **Create.** `Bot`/`BotInput` structs, CRUD, `ensure_bot_session`, `bot_memory_profile`, `persona_for_session` + tests |
| `src-tauri/src/db/chat.rs` | Modify. `ChatSession.bot_id`, row mapping, `set_chat_session_bot` |
| `src-tauri/src/db/automations.rs` | Modify. `Automation.bot_id`, `AutomationInput.bot_id`, row mapping |
| `src-tauri/src/commands/bot_cmds.rs` | **Create.** `list_bots`, `create_bot`, `update_bot`, `delete_bot`, `set_bot_enabled`, `ensure_bot_session` |
| `src-tauri/src/lib.rs` | Modify. Register the six commands in `generate_handler` (list starts at line 691) |
| `src-tauri/src/chat/tools/bots.rs` | **Create.** Chat tools `list_bots`/`create_bot`/`update_bot`/`delete_bot`/`run_bot` (mirror `chat/tools/automations.rs`) |
| `src-tauri/src/chat/tools/mod.rs` + `specs.rs` | Modify. Tool-name constants, dispatch arm, tool specs, write-classification |
| `src-tauri/src/chat/commands/send.rs` | Modify. Persona resolution at the `assistant.systemPrompt` read (line 1150) |
| `src-tauri/src/chat/mod.rs` | Modify. Persona resolution in `run_one_shot_chat` (line 2277) |
| `src-tauri/src/memory/worker.rs` | Modify. Derive memory `profile` from the session's bot |
| `src-tauri/src/automations.rs` | Modify. Bot-bound runs go through `ensure_bot_session` + chat one-shot |
| `src-tauri/src/mobile/relay.rs` | Modify. `MobileMessage::ListBots` arm (dispatch near line 1984) |
| `src/state/ui.ts` | Modify. `ActiveView` union gains `"bots"` (line 21) |
| `src/App.tsx` | Modify. Lazy import + center-area branch for BotsView (~line 91, ~519); add `"bots"` to the ChatPaneGrid exclusion (~508) |
| `src/components/sidebar/Sidebar.tsx` | Modify. Global Views block (~370): Bots pill next to Automations/Vault |
| `src/lib/ipc/bots.ts` | **Create.** `Bot` type, IPC wrappers, `onBotsChanged` listener |
| `src/hooks/useBots.ts` | **Create.** Load/create/update/delete + event refresh |
| `src/components/bots/BotsView.tsx` | **Create.** The view: left rail + center `<ChatView />` + empty-state promo |
| `src/components/bots/BotEditorModal.tsx` | **Create.** Create/edit popup (the only bot editor) |
| `src/styles/bots.css` | **Create.** Rail, promo, modal styles (tokens only) |
| `mobile/src/hooks/useRelay.ts` | Modify. `ListBots` send + `onBotsList` EventBus |
| `mobile/src/screens/BotsScreen.tsx` | **Create.** Bot list with status dots + last job summary |
| `mobile/App.tsx` | Modify. Register `Bots` screen |
| `docs/architecture/BOTS.md` | **Create.** Architecture doc (status header, per repo convention) |
| `src-tauri/src/db/bot_approvals.rs` | **Create (Task 13).** `bot_approvals` table CRUD: queue, list, resolve, expire |
| `src-tauri/src/chat/bot_policy.rs` | **Create (Task 13).** `RunOrigin`, `Gate`, `gate()`, `summarize_tool_call()` + tests |
| `src/components/bots/ApprovalInbox.tsx` | **Create (Task 13).** "Needs approval" list with Approve / Deny |
| `src/components/bots/RunsStrip.tsx` | **Create (Task 14).** Recent runs per bot; opens a run in the real ChatView |
| `src-tauri/src/local_models.rs` | Modify (Task 17). `Priority::{Interactive, Background}` on the queue |
| scheduler registration (`scripts/`, `src-tauri/src/automations*`) | Modify (Task 17, P2). launchd / systemd-user parity with the Windows sidecar |

---

### Task 1: DB schema + Bot CRUD

**Files:**
- Modify: `src-tauri/src/db/mod.rs` (init_schema at 1079; configure at ~410; migration pattern at 262)
- Create: `src-tauri/src/db/bots.rs`
- Modify: `src-tauri/src/db/mod.rs` (`pub mod bots;` — module list near the top)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Bot`, `BotInput` (serde camelCase), `create_bot(conn, &BotInput) -> DbResult<Bot>`, `get_bot(conn, id) -> DbResult<Option<Bot>>`, `list_bots(conn) -> DbResult<Vec<Bot>>`, `update_bot(conn, id, &BotPatch) -> DbResult<Bot>`, `delete_bot(conn, id, purge_memory) -> DbResult<DeleteBotOutcome>`, `set_bot_enabled(conn, id, bool) -> DbResult<()>`, `ensure_bot_session(conn, bot_id) -> DbResult<String>`, `persona_for_session(conn, chat_session_id) -> DbResult<Option<String>>`, `bot_memory_profile(bot_id: &str) -> String` (returns `bot:<id>`). Later tasks import exactly these.
- **Revision 2 additions:** `create_bot_run_session(conn, bot_id, job_id: Option<&str>, job_name) -> DbResult<String>`, `resolve_custom_prompt(conn, chat_session_id, global: Option<String>) -> DbResult<Option<String>>`, `compose_prompt(&Bot, Option<&str>) -> Option<String>`, `DeleteBotOutcome { jobs_deleted, memories }`, `BotPatch` (update is now a patch), `validate_bot_name`; `delete_bot` now takes `purge_memory`; `Bot` gains `inherit_global_prompt` and `memory_read_default`; `chat_sessions` gains `bot_role` and `bot_job_id`; `automations.bot_id` is nullable (NULL = unowned).

- [ ] **Step 1: Add the `bots` table to `init_schema`**

In `src-tauri/src/db/mod.rs`, inside the `execute_batch` of `init_schema` (after the `automations` table, ~line 1584), add:

```sql
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '🤖',
  color TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tools_enabled INTEGER NOT NULL DEFAULT 1,
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  inherit_global_prompt INTEGER NOT NULL DEFAULT 1, -- persona layers on the user's global prompt
  memory_read_default INTEGER NOT NULL DEFAULT 0,    -- bot may READ the user's `default` memory (never write)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_name_nocase ON bots(name COLLATE NOCASE); -- backstop; the friendly error comes from ensure_name_free
```

- [ ] **Step 2: Add the two column migrations**

Copy the `migrate_automations_origin` pattern (db/mod.rs:262 — `ALTER TABLE` + swallow the "duplicate column name" error; mirror that function's exact error-match shape). Add both functions next to it, and register them in `configure()` (line ~446 block) after `migrate_automations_triggers(conn)?;`:

```rust
fn migrate_chat_sessions_bot_id(conn: &Connection) -> DbResult<()> {
    // ALTER TABLE chat_sessions ADD COLUMN bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL
    // ALTER TABLE chat_sessions ADD COLUMN bot_role TEXT      -- NULL | 'thread' | 'run'   (Revision 2)
    // ALTER TABLE chat_sessions ADD COLUMN bot_job_id TEXT    -- automation that spawned a run session
    // CREATE INDEX IF NOT EXISTS idx_chat_sessions_bot ON chat_sessions(bot_id, bot_role)
    // (each ALTER swallows its own "duplicate column name"; delete_bot unbinds explicitly and does
    //  NOT rely on the FK action, because PRAGMA foreign_keys is not guaranteed on)
}

fn migrate_automations_bot_id(conn: &Connection) -> DbResult<()> {
    // ALTER TABLE automations ADD COLUMN bot_id TEXT          -- nullable; NULL = unowned (Revision 2)
    // No FK on purpose: delete_bot removes bound jobs explicitly inside its transaction.
}
```

(The statements above are the only delta from the neighboring migrations — read `migrate_automations_origin` first and mirror it.)

- [ ] **Step 3: Create `src-tauri/src/db/bots.rs`**

```rust
// Bots — named persistent agents (docs/architecture/BOTS.md). A bot is an
// identity: persona prompt + model + memory profile + standing jobs, with
// exactly one conversation of its own (ensure_bot_session). CRUD mirrors
// db/automations.rs (plain rusqlite, camelCase serde on the wire).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::now_ts;
use crate::db::DbResult;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub description: String,
    pub emoji: String,
    pub color: String,
    pub system_prompt: String,
    pub provider: String, // "" = inherit the session's provider
    pub model: String,    // "" = inherit the session's model
    pub tools_enabled: bool,
    pub memory_enabled: bool,
    pub enabled: bool,
    pub inherit_global_prompt: bool,
    pub memory_read_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotInput {
    pub name: String,
    pub description: Option<String>,
    pub emoji: Option<String>,
    pub color: Option<String>,
    pub system_prompt: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tools_enabled: Option<bool>,
    pub memory_enabled: Option<bool>,
    pub enabled: Option<bool>,
    pub inherit_global_prompt: Option<bool>,
    pub memory_read_default: Option<bool>,
}

/// Partial update (Revision 2). Only fields that are `Some` change; everything
/// else keeps its current value. `BotInput` stays the create shape.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub emoji: Option<String>,
    pub color: Option<String>,
    pub system_prompt: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tools_enabled: Option<bool>,
    pub memory_enabled: Option<bool>,
    pub enabled: Option<bool>,
    pub inherit_global_prompt: Option<bool>,
    pub memory_read_default: Option<bool>,
}

impl From<BotInput> for BotPatch {
    fn from(i: BotInput) -> Self {
        BotPatch {
            name: Some(i.name),
            description: i.description,
            emoji: i.emoji,
            color: i.color,
            system_prompt: i.system_prompt,
            provider: i.provider,
            model: i.model,
            tools_enabled: i.tools_enabled,
            memory_enabled: i.memory_enabled,
            enabled: i.enabled,
            inherit_global_prompt: i.inherit_global_prompt,
            memory_read_default: i.memory_read_default,
        }
    }
}

pub const BOT_NAME_MAX: usize = 40;

fn invalid(msg: &str) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(msg.to_string())
}

/// Trim, collapse inner whitespace, require 1..=BOT_NAME_MAX characters. The
/// messages are user-facing: the editor and the rail's inline rename show them as-is.
pub fn validate_bot_name(raw: &str) -> DbResult<String> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(invalid("Bot name can't be empty"));
    }
    if name.chars().count() > BOT_NAME_MAX {
        return Err(invalid("Bot names are limited to 40 characters"));
    }
    Ok(name)
}

/// Case-insensitive uniqueness, excluding the bot being renamed (so changing only
/// the case of its own name is allowed). Agents address bots by id, but they find
/// the id by name via `list_bots`, and approval summaries name the bot — duplicates
/// would make both ambiguous.
fn ensure_name_free(conn: &Connection, name: &str, exclude_id: Option<&str>) -> DbResult<()> {
    let taken: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM bots WHERE name = ?1 COLLATE NOCASE AND id != ?2)",
        params![name, exclude_id.unwrap_or("")],
        |r| r.get(0),
    )?;
    if taken {
        return Err(invalid(&format!("A bot named \"{name}\" already exists")));
    }
    Ok(())
}

fn row_to_bot(row: &rusqlite::Row<'_>) -> rusqlite::Result<Bot> {
    Ok(Bot {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        emoji: row.get("emoji")?,
        color: row.get("color")?,
        system_prompt: row.get("system_prompt")?,
        provider: row.get("provider")?,
        model: row.get("model")?,
        tools_enabled: row.get::<_, i64>("tools_enabled")? != 0,
        memory_enabled: row.get::<_, i64>("memory_enabled")? != 0,
        enabled: row.get::<_, i64>("enabled")? != 0,
        inherit_global_prompt: row.get::<_, i64>("inherit_global_prompt")? != 0,
        memory_read_default: row.get::<_, i64>("memory_read_default")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn create_bot(conn: &Connection, input: &BotInput) -> DbResult<Bot> {
    let name = validate_bot_name(&input.name)?;
    ensure_name_free(conn, &name, None)?;
    let id = super::new_id("bot");
    let now = now_ts();
    conn.execute(
        "INSERT INTO bots (id, name, description, emoji, color, system_prompt, provider,
                           model, tools_enabled, memory_enabled, enabled,
                           inherit_global_prompt, memory_read_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            id,
            name,
            input.description.as_deref().unwrap_or(""),
            input.emoji.as_deref().unwrap_or("🤖"),
            input.color.as_deref().unwrap_or(""),
            input.system_prompt.as_deref().unwrap_or(""),
            input.provider.as_deref().unwrap_or(""),
            input.model.as_deref().unwrap_or(""),
            input.tools_enabled.unwrap_or(true) as i64,
            input.memory_enabled.unwrap_or(true) as i64,
            input.enabled.unwrap_or(true) as i64,
            input.inherit_global_prompt.unwrap_or(true) as i64,
            input.memory_read_default.unwrap_or(false) as i64,
            now,
            now,
        ],
    )?;
    Ok(get_bot(conn, &id)?.expect("bot just inserted"))
}

pub fn get_bot(conn: &Connection, id: &str) -> DbResult<Option<Bot>> {
    let mut stmt = conn.prepare("SELECT * FROM bots WHERE id = ?1")?;
    Ok(stmt.query_row(params![id], row_to_bot).optional()?)
}

pub fn list_bots(conn: &Connection) -> DbResult<Vec<Bot>> {
    let mut stmt = conn.prepare("SELECT * FROM bots ORDER BY created_at ASC")?;
    let rows = stmt.query_map([], row_to_bot)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// PATCH semantics (Revision 2). The original applied `unwrap_or(default)` to every
/// field, so a rename-only call blanked the persona and description and silently
/// set enabled = true — which would let an agent re-enable a bot and bypass
/// "agent-created bots land disabled". Now only `Some` fields change.
pub fn update_bot(conn: &Connection, bot_id: &str, patch: &BotPatch) -> DbResult<Bot> {
    let cur = get_bot(conn, bot_id)?.ok_or_else(|| invalid(&format!("bot not found: {bot_id}")))?;
    let name = match patch.name.as_deref() {
        Some(raw) => validate_bot_name(raw)?,
        None => cur.name.clone(),
    };
    if name != cur.name {
        ensure_name_free(conn, &name, Some(bot_id))?; // excludes this bot, so a case-only change passes
    }
    let emoji = patch.emoji.clone().unwrap_or_else(|| cur.emoji.clone());
    conn.execute(
        "UPDATE bots SET name = ?2, description = ?3, emoji = ?4, color = ?5,
                         system_prompt = ?6, provider = ?7, model = ?8,
                         tools_enabled = ?9, memory_enabled = ?10, enabled = ?11,
                         inherit_global_prompt = ?12, memory_read_default = ?13,
                         updated_at = ?14
         WHERE id = ?1",
        params![
            bot_id,
            name,
            patch.description.as_ref().unwrap_or(&cur.description),
            emoji,
            patch.color.as_ref().unwrap_or(&cur.color),
            patch.system_prompt.as_ref().unwrap_or(&cur.system_prompt),
            patch.provider.as_ref().unwrap_or(&cur.provider),
            patch.model.as_ref().unwrap_or(&cur.model),
            patch.tools_enabled.unwrap_or(cur.tools_enabled) as i64,
            patch.memory_enabled.unwrap_or(cur.memory_enabled) as i64,
            patch.enabled.unwrap_or(cur.enabled) as i64,
            patch.inherit_global_prompt.unwrap_or(cur.inherit_global_prompt) as i64,
            patch.memory_read_default.unwrap_or(cur.memory_read_default) as i64,
            now_ts(),
        ],
    )?;
    if name != cur.name || emoji != cur.emoji {
        sync_thread_title(conn, bot_id, &emoji, &name)?;
    }
    Ok(get_bot(conn, bot_id)?.expect("bot exists"))
}

/// The thread's title is `"{emoji} {name}"`, written at creation — keep it in step
/// with renames and emoji changes. Run sessions keep their original titles (they
/// are history). Preflight: confirm chat sessions are not auto-retitled after the
/// first message; bot threads must be exempt or this sync gets overwritten.
fn sync_thread_title(conn: &Connection, bot_id: &str, emoji: &str, name: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET title = ?2 WHERE bot_id = ?1 AND bot_role = 'thread'",
        params![bot_id, format!("{emoji} {name}")],
    )?;
    Ok(())
}

/// Result of deleting a bot, so the UI can say exactly what happened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBotOutcome {
    pub jobs_deleted: usize,
    pub memories: usize, // rows in profile bot:<id>; purged iff purge_memory
}

/// Deleting a bot is ONE transaction and leaves nothing live behind (Revision 2):
/// 1. its standing jobs are deleted — a job without its persona is meaningless
///    and a dangling job must never fire;
/// 2. all its sessions (thread + runs) are unbound EXPLICITLY (no reliance on
///    PRAGMA foreign_keys) and stay in Chat History as plain chats;
/// 3. each unbound session's memory cursor jumps to its latest message, so old
///    bot turns are never re-extracted into the user's `default` profile;
/// 4. bot:<id> memories are purged only when `purge_memory` is set (the command
///    layer exports them to a Vault note first when the user asked for that);
/// 5. its pending/resolved approvals (Task 13) are deleted with it.
pub fn delete_bot(conn: &Connection, bot_id: &str, purge_memory: bool) -> DbResult<DeleteBotOutcome> {
    let tx = conn.unchecked_transaction()?;
    let jobs_deleted = tx.execute("DELETE FROM automations WHERE bot_id = ?1", params![bot_id])?;
    let session_ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM chat_sessions WHERE bot_id = ?1")?;
        let rows = stmt.query_map(params![bot_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    tx.execute(
        "UPDATE chat_sessions SET bot_id = NULL, bot_role = NULL, bot_job_id = NULL WHERE bot_id = ?1",
        params![bot_id],
    )?;
    for sid in &session_ids {
        // Freeze extraction. Use the existing cursor setter (grep `fn set_cursor`
        // in db/memory.rs); add `advance_cursor_to_latest` if no equivalent exists.
        super::memory::advance_cursor_to_latest(&tx, sid)?;
    }
    let profile = bot_memory_profile(bot_id);
    let memories = tx.query_row(
        "SELECT COUNT(*) FROM memories WHERE profile = ?1",
        params![profile],
        |r| r.get::<_, i64>(0),
    )? as usize;
    if purge_memory {
        tx.execute("DELETE FROM memories WHERE profile = ?1", params![profile])?;
    }
    // bot_approvals exists from Task 13; ignore "no such table" before it lands.
    let _ = tx.execute("DELETE FROM bot_approvals WHERE bot_id = ?1", params![bot_id]);
    tx.execute("DELETE FROM bots WHERE id = ?1", params![bot_id])?;
    tx.commit()?;
    Ok(DeleteBotOutcome { jobs_deleted, memories })
}

pub fn set_bot_enabled(conn: &Connection, bot_id: &str, enabled: bool) -> DbResult<()> {
    conn.execute(
        "UPDATE bots SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
        params![bot_id, enabled as i64, now_ts()],
    )?;
    Ok(())
}

/// The bot's one conversation (bot_role = 'thread'), created lazily and bound
/// via chat_sessions.bot_id — the Bots view opens it. Run sessions
/// (bot_role = 'run') share bot_id but are NEVER returned here; otherwise the
/// newest cron run would silently become "the thread" (Revision 2).
pub fn ensure_bot_session(conn: &Connection, bot_id: &str) -> DbResult<String> {
    let mut stmt = conn.prepare(
        "SELECT s.id FROM chat_sessions s
         WHERE s.bot_id = ?1 AND s.bot_role = 'thread'
         ORDER BY s.created_at DESC LIMIT 1",
    )?;
    if let Some(sid) = stmt.query_row(params![bot_id], |r| r.get::<_, String>(0)).optional()? {
        return Ok(sid);
    }
    let bot = get_bot(conn, bot_id)?.ok_or_else(|| {
        rusqlite::Error::InvalidParameterName(format!("bot not found: {bot_id}"))
    })?;
    let title = format!("{} {}", bot.emoji, bot.name);
    new_bot_session(conn, &bot, "thread", None, &title)
}

/// A fresh session for one standing-job run (or an `ask_bot` call). Same persona
/// and memory profile as the thread (both key off bot_id); separate history.
pub fn create_bot_run_session(
    conn: &Connection,
    bot_id: &str,
    job_id: Option<&str>,
    job_name: &str,
) -> DbResult<String> {
    let bot = get_bot(conn, bot_id)?.ok_or_else(|| {
        rusqlite::Error::InvalidParameterName(format!("bot not found: {bot_id}"))
    })?;
    let title = format!("{} {}", bot.emoji, job_name);
    new_bot_session(conn, &bot, "run", job_id, &title)
}

fn new_bot_session(
    conn: &Connection,
    bot: &Bot,
    role: &str,
    job_id: Option<&str>,
    title: &str,
) -> DbResult<String> {
    let (provider, model) = seed_provider_model(conn, bot)?;
    let session = super::create_chat_session_named(conn, &provider, &model, Some(title), None)?;
    super::chat::set_chat_session_bot(conn, &session.id, Some(&bot.id))?;
    super::chat::set_chat_session_bot_role(conn, &session.id, Some(role), job_id)?;
    Ok(session.id)
}

/// The bot's own provider/model if set; otherwise what the user's new chats
/// default to. NEVER hard-code a provider here (the original plan seeded
/// "openai", so an "inherit" bot inherited OpenAI whatever the user had set up).
fn seed_provider_model(conn: &Connection, bot: &Bot) -> DbResult<(String, String)> {
    if !bot.provider.is_empty() {
        return Ok((bot.provider.clone(), bot.model.clone()));
    }
    // Preflight: grep the settings keys / store defaults the composer reads for a
    // brand-new chat and use those. The two keys below are PLACEHOLDERS — confirm.
    let provider = super::get_setting(conn, "chat.provider")?.unwrap_or_default();
    let model = super::get_setting(conn, "chat.model")?.unwrap_or_default();
    Ok((provider, model))
}

/// The bot's persona as a custom system prompt, or None when the session has
/// no bot (or the bot has no custom prompt) — callers then fall back to the
/// global `assistant.systemPrompt` setting.
pub fn persona_for_session(conn: &Connection, chat_session_id: &str) -> DbResult<Option<String>> {
    let Some(bot) = get_bot_for_session(conn, chat_session_id)? else {
        return Ok(None);
    };
    let p = bot.system_prompt.trim();
    Ok((!p.is_empty()).then(|| p.to_string()))
}

/// The `custom` argument for `build_system_prompt` (Revision 2: persona LAYERS on
/// the user's global prompt instead of replacing it). Non-bot sessions get
/// `global` back untouched, so non-bot behavior is unchanged by construction.
pub fn resolve_custom_prompt(
    conn: &Connection,
    chat_session_id: &str,
    global: Option<String>,
) -> DbResult<Option<String>> {
    let Some(bot) = get_bot_for_session(conn, chat_session_id)? else {
        return Ok(global);
    };
    Ok(compose_prompt(&bot, global.as_deref()))
}

/// Pure composition rule (unit-tested): global + persona unless the bot opted
/// out of inheriting; an empty persona makes the bot a "shell" over the global
/// prompt; no global and no persona means no custom prompt at all.
pub fn compose_prompt(bot: &Bot, global: Option<&str>) -> Option<String> {
    let persona = bot.system_prompt.trim();
    let global = global.map(str::trim).filter(|g| !g.is_empty());
    match (bot.inherit_global_prompt, global, persona.is_empty()) {
        (true, Some(g), false) => Some(format!(
            "{g}\n\n---\nYou are acting as the bot \"{}\". Persona:\n{persona}",
            bot.name
        )),
        (true, Some(g), true) => Some(g.to_string()),
        (_, _, false) => Some(persona.to_string()),
        _ => None,
    }
}

fn get_bot_for_session(conn: &Connection, chat_session_id: &str) -> DbResult<Option<Bot>> {
    let mut stmt = conn.prepare(
        "SELECT b.* FROM bots b
         JOIN chat_sessions s ON s.bot_id = b.id
         WHERE s.id = ?1",
    )?;
    Ok(stmt.query_row(params![chat_session_id], row_to_bot).optional()?)
}

/// Memory namespace for a bot: the existing `memories.profile` column holds
/// `bot:<id>`, so the whole memory pipeline scopes per bot with no schema
/// change. User memory stays on `default`.
pub fn bot_memory_profile(bot_id: &str) -> String {
    format!("bot:{bot_id}")
}
```

Check `db/mod.rs` for the actual id/now helpers and whether a titled create-session fn exists (`create_chat_session` at db/chat.rs:124 takes provider/model/project — if there's no title variant, add `create_chat_session_named` alongside it or set the title with a follow-up UPDATE; keep it in db/chat.rs, not bots.rs).

- [ ] **Step 4: Register the module**

In `src-tauri/src/db/mod.rs` module list, add `pub mod bots;` next to `pub mod automations;`.

- [ ] **Step 5: Write the failing tests**

Append to `src-tauri/src/db/bots.rs` (binding uses the Task 3 `set_chat_session_bot` via `ensure_bot_session`, so write tests 2–3 after Task 3's db fn lands — or stub with a direct UPDATE as shown):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        super::super::init_schema(&c).unwrap();
        super::super::configure(&c).unwrap();
        c
    }

    fn input(name: &str) -> BotInput {
        BotInput {
            name: name.into(),
            description: Some("Morning briefing agent".into()),
            emoji: Some("🛰️".into()),
            color: Some("#4ec9b0".into()),
            system_prompt: Some("You are Atlas, a briefing agent.".into()),
            provider: Some("anthropic".into()),
            model: Some("claude-sonnet-4-5".into()),
            tools_enabled: Some(true),
            memory_enabled: Some(true),
            enabled: Some(true),
            inherit_global_prompt: Some(true),
            memory_read_default: Some(false),
        }
    }

    #[test]
    fn create_list_update_delete_roundtrip() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        assert_eq!(bot.name, "Atlas");
        assert_eq!(bot.description, "Morning briefing agent");
        assert!(bot.tools_enabled && bot.enabled);
        assert_eq!(list_bots(&c).unwrap().len(), 1);

        let mut upd = input("Atlas v2");
        upd.enabled = Some(false);
        let bot = update_bot(&c, &bot.id, &upd.into()).unwrap();
        assert_eq!(bot.name, "Atlas v2");
        assert!(!bot.enabled);
        assert_eq!(get_bot(&c, &bot.id).unwrap().unwrap().name, "Atlas v2");

        delete_bot(&c, &bot.id, false).unwrap();
        assert!(get_bot(&c, &bot.id).unwrap().is_none());
    }

    #[test]
    fn ensure_bot_session_creates_once_and_reuses() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let sid1 = ensure_bot_session(&c, &bot.id).unwrap();
        let sid2 = ensure_bot_session(&c, &bot.id).unwrap();
        assert_eq!(sid1, sid2);
        let sess = super::super::get_chat_session(&c, &sid1).unwrap().unwrap();
        assert_eq!(sess.bot_id, Some(bot.id.clone()));
        assert!(sess.title.as_deref().unwrap_or("").contains("Atlas"));
    }

    #[test]
    fn persona_for_session_resolves_bot_and_falls_back_to_none() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let sid = ensure_bot_session(&c, &bot.id).unwrap();
        let persona = persona_for_session(&c, &sid).unwrap().unwrap();
        assert!(persona.starts_with("You are Atlas"));
        // Empty bot prompt → None (fall back to the global setting).
        let mut empty = input("Quiet");
        empty.system_prompt = Some("".into());
        let b2 = create_bot(&c, &empty).unwrap();
        let sid2 = ensure_bot_session(&c, &b2.id).unwrap();
        assert!(persona_for_session(&c, &sid2).unwrap().is_none());
    }

    #[test]
    fn deleting_bot_unbinds_sessions_without_deleting_them() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let sid = ensure_bot_session(&c, &bot.id).unwrap();
        delete_bot(&c, &bot.id, false).unwrap();
        let s = super::super::get_chat_session(&c, &sid).unwrap().unwrap();
        // Explicit unbind — must not depend on PRAGMA foreign_keys being on.
        assert!(s.bot_id.is_none() && s.bot_role.is_none());
    }

    #[test]
    fn prompt_layers_persona_over_global_and_respects_opt_out() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let sid = ensure_bot_session(&c, &bot.id).unwrap();
        let both = resolve_custom_prompt(&c, &sid, Some("Reply in French.".into())).unwrap().unwrap();
        assert!(both.contains("Reply in French.") && both.contains("You are Atlas"));
        let mut opt_out = input("Atlas");
        opt_out.inherit_global_prompt = Some(false);
        update_bot(&c, &bot.id, &opt_out.into()).unwrap();
        let only = resolve_custom_prompt(&c, &sid, Some("Reply in French.".into())).unwrap().unwrap();
        assert!(!only.contains("French") && only.contains("You are Atlas"));
        // A non-bot session gets the global prompt back untouched.
        let plain = super::super::create_chat_session(&c, "openai", "gpt-5", None).unwrap();
        assert_eq!(
            resolve_custom_prompt(&c, &plain.id, Some("Reply in French.".into())).unwrap().as_deref(),
            Some("Reply in French.")
        );
    }

    #[test]
    fn deleting_bot_removes_its_standing_jobs_but_not_others() {
        // Create two automations (adjust to the db/automations.rs helpers): one with
        // bot_id = Some(bot.id), one with None. delete_bot → outcome.jobs_deleted == 1
        // and the unowned automation is still listed.
    }

    #[test]
    fn deleting_bot_can_purge_its_memory_profile() {
        // Insert two `memories` rows with profile = bot:<id> and one with 'default'
        // (db/memory.rs insert helper). delete_bot(.., true) → outcome.memories == 2
        // and the 'default' row is untouched; with purge_memory = false the bot:<id>
        // rows remain (the caller exported them).
    }

    #[test]
    fn thread_lookup_ignores_run_sessions() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let thread = ensure_bot_session(&c, &bot.id).unwrap();
        let run = create_bot_run_session(&c, &bot.id, Some("auto-1"), "Morning sweep").unwrap();
        assert_ne!(thread, run);
        // The newest session is the run — ensure_bot_session must still return the thread.
        assert_eq!(ensure_bot_session(&c, &bot.id).unwrap(), thread);
    }

    #[test]
    fn new_bot_sessions_do_not_hardcode_a_provider() {
        // bot.provider = "" and the default-provider setting = "anthropic" → the thread
        // session's provider is "anthropic"; bot.provider = "openai" → "openai".
    }

    #[test]
    fn rename_keeps_other_fields_and_syncs_thread_title() {
        let c = conn();
        let mut disabled = input("Atlas");
        disabled.enabled = Some(false);
        let bot = create_bot(&c, &disabled).unwrap();
        let sid = ensure_bot_session(&c, &bot.id).unwrap();
        let patch = BotPatch { name: Some("  Orion   Prime ".into()), ..Default::default() };
        let renamed = update_bot(&c, &bot.id, &patch).unwrap();
        assert_eq!(renamed.name, "Orion Prime");                      // trimmed + collapsed
        assert!(!renamed.enabled);                                     // a rename must NOT re-enable
        assert!(renamed.system_prompt.starts_with("You are Atlas"));   // nor blank the persona
        let s = super::super::get_chat_session(&c, &sid).unwrap().unwrap();
        assert!(s.title.as_deref().unwrap_or("").contains("Orion Prime"));
    }

    #[test]
    fn names_are_validated_and_unique_case_insensitively() {
        let c = conn();
        let a = create_bot(&c, &input("Atlas")).unwrap();
        let b = create_bot(&c, &input("Scout")).unwrap();
        assert!(create_bot(&c, &input("   ")).is_err());
        assert!(create_bot(&c, &input(&"x".repeat(41))).is_err());
        assert!(create_bot(&c, &input("atlas")).is_err());            // duplicate, any case
        let taken = BotPatch { name: Some("ATLAS".into()), ..Default::default() };
        assert!(update_bot(&c, &b.id, &taken).is_err());
        // Changing only the case of its OWN name is allowed.
        assert_eq!(update_bot(&c, &a.id, &taken).unwrap().name, "ATLAS");
    }
}
```

- [ ] **Step 6: Run tests**

Run: `cd src-tauri && cargo test db::bots`
Expected: PASS (11 tests; tests 2–11 compile once `set_chat_session_bot` and `set_chat_session_bot_role` from Task 3 exist — land Task 3's Step 3 fn first if needed).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/db/bots.rs
git commit -m "feat(bots): schema + CRUD + lazy bot thread (ensure_bot_session)"
```

---

### Task 2: Tauri commands + `bots:changed` events

**Files:**
- Create: `src-tauri/src/commands/bot_cmds.rs`
- Modify: `src-tauri/src/lib.rs` (register in `generate_handler!`, list starts at line 691; automation commands registered ~792)
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod bot_cmds;`)

**Interfaces:**
- Consumes: Task 1's `db::bots::*` fns.
- Produces: commands `list_bots`, `create_bot(input: BotInput)`, `update_bot(bot_id: String, patch: BotPatch)`, `delete_bot(bot_id: String)`, `set_bot_enabled(bot_id: String, enabled: bool)`, `ensure_bot_session(bot_id: String) -> String` (session id) — all camelCase-invocable from the frontend; event `bots:changed` with payload `{ action: "created" | "updated" | "deleted", botId: string }`.

**Revision 2 amendments (Task 2):**
- `delete_bot(bot_id: String, purge_memory: bool) -> DeleteBotOutcome { jobsDeleted, memories }`. When `purge_memory` is true and a Vault is bound, first export the bot's memories to the Vault note `Bots/<name> (deleted).md` through the existing vault atomic-write API; if no Vault is bound, purge only after the UI has confirmed it (the editor's delete dialog lists the effect, Task 8). The command never purges without being asked.
- New commands for Task 5's panel: `bot_memory_list(bot_id)` and `bot_memory_delete(bot_id, memory_id)`; the delete verifies the memory's profile is exactly `bot:<bot_id>` (a bot id must never be a route to deleting `default` rows).
- `update_bot` takes a `BotPatch` (Task 1): a rename is simply `update_bot(botId, { name })`, so there is no separate rename command. Validation errors (`Bot name can't be empty`, `Bot names are limited to 40 characters`, `A bot named "X" already exists`) are returned as the `Err(String)` message for the UI to show verbatim.
- `bots:changed` payload `action` gains `"approval"` (Task 13). Task 13 adds `list_bot_approvals` / `resolve_bot_approval`; Task 14 adds `list_bot_runs`; Task 17 adds `scheduler_available`.

- [ ] **Step 1: Write the commands file**

Model it line-for-line on `src-tauri/src/commands/automation_cmds.rs` (same `DbState` + `CmdResult` imports and lock style):

```rust
// Bots Tauri commands — thin wrappers over db::bots. Every mutation emits
// `bots:changed` so the Bots view rail and open modal refresh (same pattern
// as the automation run events).

use crate::db::{self, bots::{Bot, BotInput}};
use crate::DbState;
use tauri::{Emitter, State};

use super::CmdResult;

#[tauri::command(async)]
pub fn list_bots(db: State<'_, DbState>) -> CmdResult<Vec<Bot>> {
    let conn = db.0.lock();
    Ok(db::bots::list_bots(&conn).map_err(|e| e.to_string())?)
}

#[tauri::command(async)]
pub fn create_bot(app: tauri::AppHandle, db: State<'_, DbState>, input: BotInput) -> CmdResult<Bot> {
    let bot = {
        let conn = db.0.lock();
        db::bots::create_bot(&conn, &input).map_err(|e| e.to_string())?
    };
    let _ = app.emit("bots:changed", serde_json::json!({ "action": "created", "botId": bot.id }));
    Ok(bot)
}

// update_bot / delete_bot / set_bot_enabled: identical shape — lock, call the
// db fn, emit `bots:changed` with action "updated" / "deleted" / "updated"
// (delete carries the dead id), return the fn result.

#[tauri::command(async)]
pub fn ensure_bot_session(app: tauri::AppHandle, db: State<'_, DbState>, bot_id: String) -> CmdResult<String> {
    let sid = {
        let conn = db.0.lock();
        db::bots::ensure_bot_session(&conn, &bot_id).map_err(|e| e.to_string())?
    };
    Ok(sid)
}
```

- [ ] **Step 2: Register**

`src-tauri/src/commands/mod.rs`: `pub mod bot_cmds;`. In `lib.rs` `generate_handler![ … ]`, add under the automation entries (~line 792):

```rust
commands::bot_cmds::list_bots,
commands::bot_cmds::create_bot,
commands::bot_cmds::update_bot,
commands::bot_cmds::delete_bot,
commands::bot_cmds::set_bot_enabled,
commands::bot_cmds::ensure_bot_session,
```

- [ ] **Step 3: Verify compile**

Run: `cd src-tauri && cargo check`
Expected: clean (`ensure_bot_session`'s db dependency lands in Task 1 / Task 3 — execute Task 3's Step 3 fn before this check if running strictly in order).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/bot_cmds.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(bots): tauri commands + bots:changed event"
```

---

### Task 3: Session binding (`chat_sessions.bot_id`)

**Files:**
- Modify: `src-tauri/src/db/chat.rs` (`ChatSession` struct ~top of file, row mapping fns, add `set_chat_session_bot` near `create_chat_session` at 124 / `get_chat_session` at 342)
- Test: `#[cfg(test)]` block at the bottom of `src-tauri/src/db/chat.rs` (exists at 1243)

**Interfaces:**
- Consumes: Task 1 schema (`bot_id` column exists via migration).
- Produces: `ChatSession.bot_id: Option<String>` (Rust + TS `ChatSession.botId`), `db::chat::set_chat_session_bot(conn, chat_session_id, bot_id: Option<&str>) -> DbResult<()>` — internal, used by `ensure_bot_session` and the automations path.

- [ ] **Step 1: Write the failing test**

In the existing `#[cfg(test)]` block of db/chat.rs:

```rust
#[test]
fn set_chat_session_bot_binds_and_unbinds() {
    let conn = test_conn(); // the block's existing in-memory helper
    let s = create_chat_session(&conn, "openai", "gpt-5", None).unwrap();
    set_chat_session_bot(&conn, &s.id, Some("bot-123")).unwrap();
    assert_eq!(get_chat_session(&conn, &s.id).unwrap().unwrap().bot_id, Some("bot-123".into()));
    set_chat_session_bot(&conn, &s.id, None).unwrap();
    assert_eq!(get_chat_session(&conn, &s.id).unwrap().unwrap().bot_id, None);
}
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd src-tauri && cargo test set_chat_session_bot`
Expected: FAIL (no field/function).

- [ ] **Step 3: Implement**

- Add `pub bot_id: Option<String>,` to the `ChatSession` struct; map it in every `SELECT *` row mapper (`row.get("bot_id").ok()` — NULL-safe for pre-migration rows).
- In `create_chat_session` insert, set `bot_id = NULL` explicitly.
- Add:

```rust
pub fn set_chat_session_bot(
    conn: &Connection,
    chat_session_id: &str,
    bot_id: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET bot_id = ?2 WHERE id = ?1",
        params![chat_session_id, bot_id],
    )?;
    Ok(())
}
```

- **Revision 2 — role and job columns:** add `pub bot_role: Option<String>` (`'thread'` / `'run'` / NULL) and `pub bot_job_id: Option<String>` (the automation that spawned a run session) to `ChatSession`, mapped NULL-safe like `bot_id`. `set_chat_session_bot` keeps its signature (so the test above is unchanged); add a separate setter:

```rust
pub fn set_chat_session_bot_role(
    conn: &Connection,
    chat_session_id: &str,
    role: Option<&str>,
    job_id: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET bot_role = ?2, bot_job_id = ?3 WHERE id = ?1",
        params![chat_session_id, role, job_id],
    )?;
    Ok(())
}
```

  Add a `set_chat_session_bot_role_roundtrips` test next to the one above. Task 14 makes Chat History exclude `bot_role = 'run'`.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test db::chat`
Expected: PASS, including the pre-existing suite.

- [ ] **Step 5: TS type**

In `src/lib/ipc/chatSessions.ts`, add to the `ChatSession` interface (after `agent?`):

```typescript
  /** The bot this thread belongs to (persona + memory + jobs). Only the
   *  bot's own session carries this. null = plain chat. Persisted. */
  botId?: string | null;
  /** 'thread' = the bot's conversation, 'run' = one standing-job run (hidden from
   *  Chat History). null = plain chat. (Revision 2) */
  botRole?: "thread" | "run" | null;
  /** Automation id that spawned a run session. (Revision 2) */
  botJobId?: string | null;
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/chat.rs src/lib/ipc/chatSessions.ts
git commit -m "feat(bots): bind bot threads via chat_sessions.bot_id"
```

---

### Task 4: Persona injection (live send + one-shot paths)

**Files:**
- Modify: `src-tauri/src/chat/commands/send.rs:1148-1150`
- Modify: `src-tauri/src/chat/mod.rs:2277-2285` (inside `run_one_shot_chat`, signature at 2223)

**Interfaces:**
- Consumes: `db::bots::resolve_custom_prompt` (Task 1; `persona_for_session` remains as the pure persona accessor).
- Produces: behavioral contract — the bot's own session (any session with `bot_id`) uses `db::bots::resolve_custom_prompt` (the user's global prompt **plus** the bot persona, unless the bot sets `inherit_global_prompt = false`) as the `custom` argument to `build_system_prompt`; everything else unchanged. **Revision 2:** the persona layers on the global prompt instead of replacing it, and the original snippet (a `?` inside an `.or_else` closure returning `Option`) is replaced.

- [ ] **Step 1: Live send path**

Replace send.rs:1150 (`let custom = db::get_setting(&conn, "assistant.systemPrompt")…`) with:

```rust
        // Persona LAYERS on the user's global prompt (Revision 2). A session with
        // no bot gets `global` back unchanged, so non-bot behavior is identical.
        let global = db::get_setting(&conn, "assistant.systemPrompt").map_err(|e| e.to_string())?;
        let custom = db::bots::resolve_custom_prompt(&conn, &chat_session_id, global)
            .map_err(|e| e.to_string())?;
```

(`chat_session_id` is already in scope in this function — it's the same variable persisted per turn.)

- [ ] **Step 2: One-shot path (automations, bot jobs, headless runs)**

Replace mod.rs:2277-2283 with:

```rust
    let system_prompt = {
        let conn = db.lock();
        let global = crate::db::get_setting(&conn, "assistant.systemPrompt").ok().flatten();
        crate::db::bots::resolve_custom_prompt(&conn, chat_session_id, global)
            .ok()
            .flatten()
            .unwrap_or_default()
    };
```

Also extend the provider/model resolution just above (mod.rs:2270-2275): when the session's bot has a non-empty `provider`/`model`, use those over the passed arguments (one lookup via `db::bots::persona_for_session`'s sibling — add `pub fn model_for_session(conn, chat_session_id) -> DbResult<Option<(String, String)>>` in db/bots.rs returning the bot's non-empty provider/model pair).

- [ ] **Step 3: Verify the contract**

Run: `cd src-tauri && cargo test && cargo check`
Expected: PASS — the Task 1 `persona_for_session` tests are the unit-level contract; both call sites are one-line resolutions of it.

Manual smoke: create a bot whose prompt is `Always answer in exactly three words.`, open its thread in the Bots view, send a message, confirm the reply obeys the persona; a brand-new plain chat must behave exactly as before. **Revision 2:** with the global assistant prompt set to `Always reply in French`, the bot's three-word replies are in French; with `inherit_global_prompt` off in the editor they are not.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/chat/commands/send.rs src-tauri/src/chat/mod.rs src-tauri/src/db/bots.rs
git commit -m "feat(bots): bot persona + model override in its own thread"
```

---

### Task 5: Bot-scoped memory (`profile = bot:<id>`)

**Files:**
- Modify: `src-tauri/src/memory/worker.rs:206-222` (`extract_session` fast-exit block)
- Modify: extraction/recall call sites found by the grep in Step 1 (worker.rs, extract.rs, retrieve.rs, db/memory.rs)
- Modify: memory chat-tool handlers (`memory_save` / `memory_recall` / `memory_forget` — find them under `src-tauri/src/chat/tools/`)
- Modify (Revision 2): the user-facing `MemoryPanel` component (find under `src/components/`) — optional `profile` prop; `src-tauri/src/commands/bot_cmds.rs` — `bot_memory_list` / `bot_memory_delete` (Task 2)

**Interfaces:**
- Consumes: `db::bots::bot_memory_profile` (Task 1), `ChatSession.bot_id` (Task 3).
- Produces: contract — every memory write/read performed in the bot's thread uses profile `bot:<botId>`; user sessions keep `default`.

- [ ] **Step 1: Enumerate the hardcoded profile sites**

Run: `grep -rn '"default"' src-tauri/src/memory/ src-tauri/src/db/memory.rs src-tauri/src/chat/tools/ | grep -i "profile\|memory"`
Expected: a short list of literal-profile call sites (extraction save, retrieval, the memory tools). These are the only places to change — the SQL already filters `WHERE profile = ?1`.

- [ ] **Step 2: Derive the profile from the session in `extract_session`**

worker.rs:210-222 — extend the fast-exit tuple:

```rust
    let (cursor, project_id, profile) = {
        let conn = db.0.lock();
        if !crate::memory::memory_enabled(&conn) {
            return Ok(());
        }
        let sess = db::get_chat_session(&conn, chat_session_id)
            .map_err(|e| e.to_string())?;
        let profile = sess
            .as_ref()
            .and_then(|s| s.bot_id.as_deref())
            .map(crate::db::bots::bot_memory_profile)
            .unwrap_or_else(|| "default".to_string());
        (
            db::get_cursor(&conn, chat_session_id).map_err(|e| e.to_string())?,
            sess.and_then(|s| s.project_id),
            profile,
        )
    };
```

Then thread `&profile` into the extraction save path (the Step 1 sites inside worker.rs/extract.rs): every `save`/`insert` that hardcoded `"default"` takes the derived profile instead. Respect `Bot.memory_enabled`: when the profile is a bot profile, look up the bot and skip extraction entirely if the flag is off (still advance the cursor so it doesn't re-scan).

- [ ] **Step 3: Retrieval + tools**

- In the retrieval path that builds the per-turn memory profile passed to `build_system_prompt` (`memory_profile` param, prompts.rs:823), resolve the session's bot the same way and pass `bot:<id>` — bot threads recall their own memories, plus the user's `default` memories **read-only** when the bot's `memory_read_default` is on (see Step 3b).
- In the `memory_save` / `memory_recall` / `memory_forget` tool handlers, resolve the profile from the session id the tool runs in (same `bot_memory_profile` call). The bot saving a memory lands it in its own namespace; the user's `default` namespace is never touched from a bot thread.

- [ ] **Step 3b (Revision 2): make bot memory visible, editable, and optionally read-through**

1. `MemoryPanel` gains an optional `profile?: string` prop (default `"default"`, so the user-facing panel is unchanged). `BotEditorModal` (Task 8) mounts it with `profile={"bot:" + bot.id}` in a **Memory** section, so the owner can read and delete everything a bot has learned. It is backed by `bot_memory_list` / `bot_memory_delete` (Task 2); the delete refuses any row whose profile is not `bot:<bot_id>`.
2. `memory_read_default` (Task 1 column): the retrieval path builds its profile list as `[bot:<id>]` plus `default` when the flag is on. Retrieval takes `&[String]` (`WHERE profile IN (...)`). **Writes never take the list**: extraction and `memory_save` / `memory_forget` use the bot's own profile only, so a bot can never edit or delete user memory.
3. Tests: (a) flag off → a bot thread's recall excludes a `default` row; (b) flag on → it includes it; (c) `memory_save` from a bot thread lands in `bot:<id>` regardless of the flag; (d) `bot_memory_delete` refuses a `default` row.

- [ ] **Step 4: Test**

Add a unit test in worker.rs's test module (create one if the file has none — pattern from db tests):

```rust
#[tokio::test]
async fn bot_session_memory_uses_bot_profile() {
    // in-memory conn + init_schema + configure; create bot + ensure session;
    // insert two user/assistant messages past the cursor; run extract_session;
    // assert the produced rows in `memories` have profile = bot:<id> and that
    // profile 'default' has no new rows.
}
```

If the extraction path requires a live model call, factor the profile-derivation into a small pure fn `pub fn memory_profile_for_session_row(bot_id: Option<&str>) -> String` and unit-test that plus an integration-style assert on a manually inserted memory row being recalled only under the bot profile.

Run: `cd src-tauri && cargo test memory`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/memory/ src-tauri/src/db/memory.rs src-tauri/src/chat/tools/
git commit -m "feat(bots): per-bot memory namespace via profile bot:<id>"
```

---

### Task 6: Frontend IPC layer + `useBots` hook

**Files:**
- Create: `src/lib/ipc/bots.ts`
- Create: `src/hooks/useBots.ts`
- Test: `src/test/botsIpc.test.ts`

**Interfaces:**
- Consumes: Task 2 commands.
- Produces: `Bot` interface (with `description`), `listBots()`, `createBot(input: BotInput)`, `updateBot(botId, input)`, `deleteBot(botId)`, `setBotEnabled(botId, enabled)`, `ensureBotSession(botId) -> Promise<string>`, `onBotsChanged` listener, and `useBots()` → `{ bots, loading, createBot, updateBot, deleteBot, setBotEnabled }` with auto-refresh on `bots:changed`.

- [ ] **Step 1: Write the failing test**

Pattern-match `src/test/agentModelPicker.test.tsx` style (vitest + testing-library; mock `safeInvoke` the way existing ipc tests do — see `src/test/` for the established mock import path):

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("../lib/ipc/ipcCore", () => ({
  safeInvoke: (...args: unknown[]) => invokeMock(...args),
}));

import { listBots, createBot, ensureBotSession } from "../lib/ipc/bots";

describe("bots ipc", () => {
  beforeEach(() => invokeMock.mockReset());

  it("listBots invokes list_bots", async () => {
    invokeMock.mockResolvedValue([{ id: "bot-1", name: "Atlas", emoji: "🛰️", description: "Briefings" }]);
    const bots = await listBots();
    expect(invokeMock).toHaveBeenCalledWith("list_bots");
    expect(bots[0].description).toBe("Briefings");
  });

  it("createBot camelCases the payload", async () => {
    invokeMock.mockResolvedValue({ id: "bot-2", name: "Scout" });
    await createBot({ name: "Scout", description: "Repo watcher", systemPrompt: "You are Scout.", toolsEnabled: true });
    expect(invokeMock).toHaveBeenCalledWith("create_bot", {
      input: { name: "Scout", description: "Repo watcher", systemPrompt: "You are Scout.", toolsEnabled: true },
    });
  });

  it("ensureBotSession returns the thread id", async () => {
    invokeMock.mockResolvedValue("sess-77");
    const sid = await ensureBotSession("bot-1");
    expect(invokeMock).toHaveBeenCalledWith("ensure_bot_session", { botId: "bot-1" });
    expect(sid).toBe("sess-77");
  });
});
```

- [ ] **Step 2: Run, watch it fail**

Run: `npx vitest run src/test/botsIpc.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/ipc/bots.ts`**

Follow `src/lib/ipc/chatSessions.ts` header-comment + `safeInvoke` conventions:

```typescript
// Bots — wire types and IPC for named persistent agents
// (docs/architecture/BOTS.md). A bot owns a persona, a memory profile,
// standing jobs (automations bound by botId), and one conversation of its
// own (ensureBotSession).

import { safeInvoke } from "../ipcCore";

export interface Bot {
  id: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  systemPrompt: string;
  provider: string; // "" = inherit session provider
  model: string;    // "" = inherit session model
  toolsEnabled: boolean;
  memoryEnabled: boolean;
  enabled: boolean;
  inheritGlobalPrompt: boolean; // persona layers on the user's global prompt
  memoryReadDefault: boolean;   // may READ the user's default memory (never write)
  createdAt: number;
  updatedAt: number;
}

export interface BotInput {
  name: string;
  description?: string;
  emoji?: string;
  color?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  toolsEnabled?: boolean;
  memoryEnabled?: boolean;
  enabled?: boolean;
  inheritGlobalPrompt?: boolean;
  memoryReadDefault?: boolean;
}

export const listBots = () => safeInvoke<Bot[]>("list_bots");
export const createBot = (input: BotInput) => safeInvoke<Bot>("create_bot", { input });
// Patch semantics (Revision 2): send only what changed. A rename is updateBot(id, { name }).
export const updateBot = (botId: string, patch: Partial<BotInput>) =>
  safeInvoke<Bot>("update_bot", { botId, patch });
export interface DeleteBotOutcome { jobsDeleted: number; memories: number }
export const deleteBot = (botId: string, purgeMemory = false) =>
  safeInvoke<DeleteBotOutcome>("delete_bot", { botId, purgeMemory });
export const setBotEnabled = (botId: string, enabled: boolean) =>
  safeInvoke<void>("set_bot_enabled", { botId, enabled });
export const ensureBotSession = (botId: string) =>
  safeInvoke<string>("ensure_bot_session", { botId });
```

**Revision 2 (Task 6):** the Task 6–8 tests build full `Bot` objects; add `inheritGlobalPrompt: true, memoryReadDefault: false` to each fixture (a shared `makeBot()` test helper avoids repeating the object in three files).

- [ ] **Step 4: Implement `src/hooks/useBots.ts`**

```typescript
import { useCallback, useEffect, useState } from "react";
import {
  type Bot, type BotInput,
  listBots, createBot as ipcCreateBot, updateBot as ipcUpdateBot,
  deleteBot as ipcDeleteBot, setBotEnabled as ipcSetBotEnabled,
} from "../lib/ipc/bots";

/** Loads the bot roster and keeps it fresh across bots:changed events. */
export function useBots() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setBots(await listBots());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const un = listenBotsChanged(() => void refresh());
    return () => { un.then((f) => f()); };
  }, [refresh]);

  const createBot = useCallback(async (input: BotInput) => {
    const bot = await ipcCreateBot(input);
    await refresh();
    return bot;
  }, [refresh]);
  // updateBot / deleteBot / setBotEnabled: same shape — call ipc, refresh.

  return { bots, loading, createBot, updateBot, deleteBot, setBotEnabled };
}
```

Import `listenBotsChanged` from `src/lib/ipc/bots.ts` — implement it there with `@tauri-apps/api/event` `listen("bots:changed", cb)` exactly the way existing listeners in `src/lib/ipc/` do (copy the nearest example, e.g. the automation run-finished listener).

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/test/botsIpc.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ipc/bots.ts src/hooks/useBots.ts src/test/botsIpc.test.ts
git commit -m "feat(bots): frontend ipc layer + useBots hook"
```

---

### Task 7: The Bots view (rail + real ChatView)

**Revision 2 (Task 7):** the rail row gains two states beyond the dot: **gold** (`--state-waiting`) with a count when the bot has pending approvals (Task 13), and a dimmed row with an **Approve** action when `enabled = false` (Task 15). The jobs strip (Task 9 Step 5) becomes the bot's *activity* area: jobs, recent runs (Task 14) and the approval inbox (Task 13). Each run opens in the same real `ChatView` via `selectSession(runSessionId)`. The "Standing jobs run only while Relay is open" badge (Task 17 Step 2) can be pulled forward into this task.

**Rename (Revision 2):** double-clicking a bot's name in the rail (or a context-menu **Rename**) turns it into an inline input. Enter or blur saves through `updateBot(botId, { name })`; Esc cancels. Validation errors from the backend (empty, over 40 characters, duplicate) show inline and keep the input open. The rail follows via `bots:changed`; the thread's Chat History title follows via the title sync in `update_bot` (Task 1). Vitest: Enter saves the patch, Esc reverts, a duplicate-name error keeps the input open and shows the message.

**Files:**
- Modify: `src/state/ui.ts:21` (`ActiveView` union gains `"bots"`)
- Modify: `src/App.tsx` (lazy import ~line 91; add `"bots"` to the ChatPaneGrid exclusion at ~508; center-area branch at ~519)
- Modify: `src/components/sidebar/Sidebar.tsx:370-388` (Global Views block: Bots pill next to Automations/Vault, `onClick={() => setActiveView("bots")}`)
- Create: `src/components/bots/BotsView.tsx`
- Create: `src/styles/bots.css` (import from `src/styles/global.css`, keeping the existing import order convention)
- Test: `src/test/botsView.test.tsx`

**Interfaces:**
- Consumes: `useBots` (Task 6), `ensureBotSession`, `useChatStore.selectSession`, `<ChatView />` (renders the active session from the store), `BotEditorModal` (Task 8).
- Produces: `ActiveView` member `"bots"`; `BotsView` component; rail row contract `{ bot, active, running }`.

- [ ] **Step 1: Register the view**

1. `src/state/ui.ts`: `export type ActiveView = … | "bots";`
2. `src/App.tsx`: `const BotsView = lazy(() => import("./components/bots/BotsView").then((m) => ({ default: m.BotsView })));` next to the other lazy views (line ~91).
3. `src/App.tsx` ~508: add `&& baseView !== "bots"` to the ChatPaneGrid exclusion condition (bots replaces the center area, like automations/wiki/vault).
4. `src/App.tsx` ~519: `) : baseView === "bots" ? (<Suspense fallback={null}><BotsView /></Suspense>)` — insert before the vault fallback branch, mirroring the wiki branch's comment style.
5. `src/components/sidebar/Sidebar.tsx` Global Views (~370): copy the Automations pill button, change to `setActiveView("bots")`, label "Bots", `is-active` class keyed on `activeView === "bots"`. Also add `"bots"` to the full-page-views check at lines 72-74 (back/forward arrows swap, like automations/vault/wiki).

- [ ] **Step 2: Write the failing component test**

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BotsView } from "../components/bots/BotsView";
import type { Bot } from "../lib/ipc/bots";

// Mock the chat store's selectSession + ChatView (jsdom: the real one pulls
// the whole composer tree) — see src/test/setup.ts for existing global stubs.
const selectSession = vi.fn().mockResolvedValue(undefined);
vi.mock("../state/chat", () => ({
  useChatStore: (sel: any) => sel({ selectSession, activeChatSessionId: "s1" }),
}));
vi.mock("../components/chat/ChatView", () => ({
  ChatView: () => <div data-testid="chatview" />,
}));

const bots: Bot[] = [
  { id: "b1", name: "Atlas", description: "Morning briefings", emoji: "🛰️", color: "#4ec9b0", systemPrompt: "", provider: "", model: "", toolsEnabled: true, memoryEnabled: true, enabled: true, createdAt: 1, updatedAt: 1 },
  { id: "b2", name: "Scout", description: "Repo watcher", emoji: "🔎", color: "#88C0D0", systemPrompt: "", provider: "", model: "", toolsEnabled: true, memoryEnabled: true, enabled: true, createdAt: 2, updatedAt: 2 },
];

vi.mock("../hooks/useBots", () => ({
  useBots: () => ({ bots, loading: false, createBot: vi.fn(), updateBot: vi.fn(), deleteBot: vi.fn(), setBotEnabled: vi.fn() }),
}));

describe("BotsView", () => {
  it("renders the rail with name, emoji and description", () => {
    render(<BotsView />);
    expect(screen.getByText("Atlas")).toBeTruthy();
    expect(screen.getByText("Morning briefings")).toBeTruthy();
    expect(screen.getByText("Repo watcher")).toBeTruthy();
  });

  it("selecting a bot selects its session and mounts the real ChatView", async () => {
    render(<BotsView />);
    fireEvent.click(screen.getByText("Scout"));
    // ensure_bot_session resolves to "s2" in the mocked ipc layer
    expect(selectSession).toHaveBeenCalledWith("s2");
    expect(screen.getByTestId("chatview")).toBeTruthy();
  });

  it("empty roster shows the create-bot promo", () => {
    vi.mocked(useBotsMock).mockReturnValueOnce({ bots: [], loading: false, createBot: vi.fn(), updateBot: vi.fn(), deleteBot: vi.fn(), setBotEnabled: vi.fn() });
    render(<BotsView />);
    fireEvent.click(screen.getByText(/Create your first bot/i));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
```

(Make `ensureBotSession` resolve `"s1"`/`"s2"` per bot id in the ipc mock; export a mutable `useBotsMock` handle from the mock factory so the empty-roster test can override.)

- [ ] **Step 3: Run, watch it fail**

Run: `npx vitest run src/test/botsView.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `BotsView.tsx`**

Structure (styles in `src/styles/bots.css`, tokens only):

```tsx
import { useCallback, useEffect, useState } from "react";
import { ChatView } from "../chat/ChatView";
import { BotEditorModal } from "./BotEditorModal";
import { useBots } from "../../hooks/useBots";
import { ensureBotSession, type Bot } from "../../lib/ipc/bots";
import { useChatStore } from "../../state/chat";

/** The Bots destination view: bot rail on the left, the bot's conversation
 *  (the real ChatView, main-pane style) in the center. Selecting a bot
 *  lazily creates its thread and selects it in the chat store, so the same
 *  session also opens from Chat History. */
export function BotsView() {
  const { bots, loading, createBot, updateBot, deleteBot, setBotEnabled } = useBots();
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const selectSession = useChatStore((s) => s.selectSession);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);

  const openBot = useCallback(async (bot: Bot) => {
    const sid = await ensureBotSession(bot.id);
    setActiveBotId(bot.id);
    await selectSession(sid, { recordNav: true });
  }, [selectSession]);

  // Auto-open the first bot so the view is never blank.
  useEffect(() => {
    if (!activeBotId && bots.length > 0) void openBot(bots[0]);
  }, [bots, activeBotId, openBot]);

  if (!loading && bots.length === 0) {
    return (
      <div className="bots-view bots-empty">
        <div className="bots-promo">
          <div className="bots-promo-glyph">◎</div>
          <h2>No bots yet</h2>
          <p>Bots are named agents with their own persona, memory, and standing jobs. They run on this machine — even while Relay is closed.</p>
          <button className="primary" onClick={() => setEditorOpen(true)}>Create your first bot</button>
        </div>
        {editorOpen && <BotEditorModal onClose={() => setEditorOpen(false)} onCreate={createBot} />}
      </div>
    );
  }

  return (
    <div className="bots-view">
      <aside className="bots-rail">
        {bots.map((b) => (
          <button
            key={b.id}
            className={`bots-rail-row${b.id === activeBotId ? " is-active" : ""}${b.enabled ? "" : " is-disabled"}`}
            onClick={() => void openBot(b)}
          >
            <span className="bots-rail-dot" style={{ background: b.color || "var(--state-idle)" }} />
            <span className="bots-rail-main">
              <span className="bots-rail-name">{b.emoji} {b.name}</span>
              <span className="bots-rail-desc">{b.description || "No description"}</span>
            </span>
          </button>
        ))}
        <button className="bots-rail-add" onClick={() => setEditorOpen(true)}>＋ New bot</button>
      </aside>
      <section className="bots-center">
        {activeChatSessionId ? <ChatView /> : null}
      </section>
      {editorOpen && <BotEditorModal onClose={() => setEditorOpen(false)} onCreate={createBot} />}
    </div>
  );
}
```

- [ ] **Step 5: Styles (`src/styles/bots.css`)**

`.bots-view` = grid `230px minmax(0, 1fr)`, height 100%; `.bots-rail` = `var(--sidebar-bg)`, right border `var(--border)`, rows with dot + two-line text (name `var(--text)`, desc `var(--text-faint)`, ellipsis); `.is-active` row = `var(--sidebar-active-bg)`; `.bots-center` = `min-width: 0` wrapper (ChatView fills it); `.bots-promo` = centered card, `var(--surface-glass)`, `var(--radius)`, `var(--glass-shadow)`; modal styles in Task 8. Use only existing tokens — no new colors.

- [ ] **Step 6: Run tests + manual smoke**

Run: `npx vitest run src/test/botsView.test.tsx`
Expected: PASS. Manual: header pill switches views; rail selection swaps the center conversation; a bot's thread appears in Chat History and opens identically from the chat view; empty workspace shows the promo.

- [ ] **Step 7: Commit**

```bash
git add src/state/ui.ts src/App.tsx src/components/sidebar/Sidebar.tsx src/components/bots/BotsView.tsx src/styles/bots.css src/styles/global.css src/test/botsView.test.tsx
git commit -m "feat(bots): Bots view — bot rail + real ChatView + create promo"
```

---

### Task 8: BotEditorModal (the only editor — no settings page)

**Revision 2 (Task 8):** the modal gains (a) a **"Use my global instructions"** toggle (`inheritGlobalPrompt`, default on); (b) a **"Can read my memory"** toggle (`memoryReadDefault`, default off) with one line of help text saying the bot can read but never change it; (c) a **Memory** section — `MemoryPanel` with `profile="bot:<id>"` (Task 5 Step 3b) so everything the bot remembers is visible and deletable; (d) a **delete confirmation** that lists the effect before it happens: "Deletes N standing jobs · keeps the conversation as a normal chat · [x] Delete M memories (exported to a Vault note first when a Vault is bound)" — values come from a dry-run count; the call passes `purgeMemory` from the checkbox. (e) `toolsEnabled` is labelled "Allow tools" with help text "Off = chat only" (Task 15 gives it teeth). (f) The **Name** field uses the same rules as the backend (1–40 characters, unique ignoring case) for instant feedback, but the backend is authoritative: a rejected save shows the returned message under the field and the modal stays open. The modal edits through `onUpdate(botId, patch)` and sends only fields the user changed. Test: renaming to an existing bot's name shows the error and does not close the modal.

**Files:**
- Create: `src/components/bots/BotEditorModal.tsx`
- Modify: `src/styles/bots.css` (modal styles)
- Test: `src/test/botEditorModal.test.tsx`

**Interfaces:**
- Consumes: `Bot`, `BotInput`, `createBot`/`updateBot` from `useBots` (Task 6).
- Produces: `BotEditorModal` props `{ bot?: Bot | null; onClose: () => void; onCreate: (input: BotInput) => Promise<Bot>; onUpdate?: (botId: string, patch: Partial<BotInput>) => Promise<Bot> }`. When `bot` is set it edits; otherwise it creates. Rail rows also get an edit (pencil) affordance opening this modal.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BotEditorModal } from "../components/bots/BotEditorModal";

const base = { onClose: vi.fn(), onCreate: vi.fn().mockResolvedValue({ id: "b9" }) };

describe("BotEditorModal", () => {
  it("creates with name, description, emoji, persona and toggles", async () => {
    render(<BotEditorModal {...base} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Atlas" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Morning briefings" } });
    fireEvent.change(screen.getByLabelText("Persona"), { target: { value: "Be terse." } });
    fireEvent.click(screen.getByText("Save"));
    await vi.waitFor(() => expect(base.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Atlas", description: "Morning briefings", systemPrompt: "Be terse." }),
    ));
  });

  it("edits the passed bot and calls onUpdate", async () => {
    const onUpdate = vi.fn().mockResolvedValue({ id: "b1" });
    render(<BotEditorModal {...base} onUpdate={onUpdate} bot={
      { id: "b1", name: "Atlas", description: "", emoji: "🛰️", color: "#4ec9b0", systemPrompt: "Old", provider: "", model: "", toolsEnabled: true, memoryEnabled: true, enabled: true, createdAt: 1, updatedAt: 1 }
    } />);
    fireEvent.change(screen.getByLabelText("Persona"), { target: { value: "New" } });
    fireEvent.click(screen.getByText("Save"));
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith("b1", expect.objectContaining({ systemPrompt: "New" })));
  });
});
```

- [ ] **Step 2: Run, watch it fail**

Run: `npx vitest run src/test/botEditorModal.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `BotEditorModal.tsx`**

A centered dialog over a scrim (match the app's existing overlay conventions — see `overlays.css` classes and how other modals close on Escape/scrim click). Fields, in order:
- **Name** (text input, `aria-label="Name"`), **Description** (text input, one line — this is the rail's second row).
- **Emoji** (short text input; v1 emoji, sprite upload is a follow-up).
- **Dot color**: six swatches `["#4ec9b0", "#88C0D0", "#dcdcaa", "#ce9178", "#c586c0", "#a0a0a0"]` (the app's token accents); selected swatch gets a ring.
- **Persona** (`aria-label="Persona"`, textarea 5 rows, placeholder: `Who is this bot and how does it behave? Its thread uses this instead of your assistant prompt.`) + hint: `Empty persona falls back to your assistant prompt.`
- **Model row**: provider select (existing provider options) + model text input; empty = "Inherit from the chat's model chip".
- **Toggles**: Tools ("Search, browser, files, code exec.") and Memory ("Its own memory, separate from yours.").
- Footer: Delete (danger, only when editing, app's existing confirm pattern), Cancel, **Save** (primary).

On save: build `BotInput` (trim name; require non-empty), call `onCreate`/`onUpdate`, close on success.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/test/botEditorModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/bots/BotEditorModal.tsx src/styles/bots.css src/test/botEditorModal.test.tsx
git commit -m "feat(bots): BotEditorModal — the single create/edit surface"
```

---

### Task 9: Bot-bound automations (standing jobs)

**Files:**
- Modify: `src-tauri/src/db/automations.rs` (struct at 17, input at 102, row mapper, `create_automation` at 149 / `update_automation` at 172)
- Modify: `src-tauri/src/automations.rs` (run prep inside `execute` at 725; `launch_run` at 278)
- Modify: `src/components/bots/BotsView.tsx` (jobs strip for the selected bot — see Step 5)
- Test: `#[cfg(test)]` block in db/automations.rs or automations.rs

**Interfaces:**
- Consumes: `db::bots::create_bot_run_session` (Task 1, Revision 2), persona injection (Task 4).
- Produces: `Automation.botId: string | null` (`null` = unowned, existing behavior); contract — a bot-bound run executes through `run_one_shot_chat` in a **fresh run session of that bot** (`bot_role = 'run'`, `bot_job_id` = the automation), so persona + memory apply with no extra plumbing, and the conversation thread is not touched until Task 14 posts the summary.

- [ ] **Step 1: Failing test**

```rust
#[test]
fn bot_run_uses_the_bots_own_session() {
    let conn = test_conn(); // in-memory + init_schema + configure
    let bot = db::bots::create_bot(&conn, &atlas_input()).unwrap();
    let automation = db::automations::create_automation(&conn, &AutomationInput {
        name: "Morning sweep".into(),
        prompt: "Sweep the inbox and brief me.".into(),
        harness: "chat".into(),
        model: String::new(),
        cwd: String::new(),
        schedule: "0 9 * * *".into(),
        enabled: Some(true),
        origin: Some("user".into()),
        trigger_type: Some("cron".into()),
        trigger_config: Some("{}".into()),
        bot_id: Some(bot.id.clone()),
    }).unwrap();

    let thread = db::bots::ensure_bot_session(&conn, &bot.id).unwrap();
    let sid = automations::prepare_bot_run(&conn, &automation).unwrap();
    let session = db::get_chat_session(&conn, &sid).unwrap().unwrap();
    assert_eq!(session.bot_id, Some(bot.id.clone()));
    assert_eq!(session.bot_role.as_deref(), Some("run"));
    assert_eq!(session.bot_job_id.as_deref(), Some(automation.id.as_str()));
    // Revision 2: every run gets its OWN session; the thread is untouched and
    // ensure_bot_session still returns it.
    let sid2 = automations::prepare_bot_run(&conn, &automation).unwrap();
    assert_ne!(sid, sid2);
    assert_ne!(sid, thread);
    assert_eq!(db::bots::ensure_bot_session(&conn, &bot.id).unwrap(), thread);
}

#[test]
fn disabled_bot_refuses_to_run() {
    // Task 15 semantics: bot.enabled = false → prepare_bot_run returns Err and
    // no run session is created.
}
```

- [ ] **Step 2: Run, watch it fail**

Run: `cd src-tauri && cargo test prepare_bot_run`
Expected: FAIL (function doesn't exist).

- [ ] **Step 3: Implement**

- db/automations.rs: add `pub bot_id: Option<String>,` to `Automation` (`#[serde(default)]` so old JSON payloads deserialize; NULL = unowned — Revision 2 drops the empty-string sentinel), `pub bot_id: Option<String>` to `AutomationInput`, map the column in the row mapper, set it in create/update (default `None`).
- automations.rs — new helper called from the run-prep region of `execute` (before the harness/chat branch):

```rust
/// Bot-bound runs execute in a FRESH run session of the bot
/// (create_bot_run_session), so run_one_shot_chat picks up the persona
/// (chat/mod.rs) and memory scopes to profile bot:<id> (memory/worker.rs) while
/// the user's conversation thread stays a conversation. Refuses disabled bots
/// (Task 15). Unowned automations never come through here.
pub fn prepare_bot_run(
    conn: &rusqlite::Connection,
    automation: &Automation,
) -> Result<String, String> {
    let Some(bot_id) = automation.bot_id.as_deref() else {
        return Err("not a bot-bound automation".into());
    };
    let bot = db::bots::get_bot(conn, bot_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("bot not found: {bot_id}"))?;
    if !bot.enabled {
        return Err("bot is disabled".into());
    }
    db::bots::create_bot_run_session(conn, bot_id, Some(&automation.id), &automation.name)
        .map_err(|e| e.to_string())
}
```

- In `execute` (:725): when `automation.bot_id.is_some()`, take the chat branch — `prepare_bot_run`, then `crate::chat::run_one_shot_chat(db, &sid, &automation.prompt, &provider, &model, cancel)` (provider/model resolve from the bot via Task 4's `model_for_session`). CLI-harness spawning stays untouched for unowned automations. Also record the run session via the existing `set_automation_chat_session` so the run history keeps linking to the thread.

- **Revision 2 — run semantics:** (a) pass `RunOrigin::Background` into `run_one_shot_chat` for bot-bound runs so Task 13's write gate applies; (b) after the run finishes (success, failure or cancel) call `post_run_summary` and `prune_runs` (Task 14); (c) request local-model `Priority::Background` (Task 17); (d) the Windows run-while-closed path (`relay-automation run-due` → `run_blocking`) goes through the same `prepare_bot_run`, so it inherits all of the above.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test`
Expected: PASS — full suite (pre-existing `AutomationInput` literals need the new `bot_id: None` field; that's expected mechanical breakage).

- [ ] **Step 5: Jobs strip in the Bots view**

Below the rail's selected bot (or as a collapsible section under the rail row — follow the AutomationsView row idiom): list automations where `botId === selected.id` (existing `list_automations` IPC), each row = name, schedule (mono, `automation_next_fire` for cron), last status dot (`--state-working` / `--state-waiting` / `--danger` from `list_automation_runs`), and a "Run now" button (`run_automation_now`). "Add job" opens a small inline form (name, cron, prompt) calling `create_automation` with `botId` set. Keep it minimal — the Automations view remains the deep-management surface for jobs.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/automations.rs src-tauri/src/automations.rs src/components/bots/BotsView.tsx
git commit -m "feat(bots): bot-bound automations — standing jobs in the bot's thread"
```

---

### Task 10: Chat tools — manage bots from the main chat

**Revision 2 (Task 10):** (a) `run_bot` creates a *run session* (`create_bot_run_session`) and runs it with `RunOrigin::Background`, so Task 13's write gate applies; it returns the run session id plus a one-line status and does not append to the bot's thread (Task 14 posts the summary). (b) The agent-facing `delete_bot` always passes `purge_memory = false`; only the Bots view can purge memory. (c) `create_bot` args gain optional `inherit_global_prompt` and `memory_read_default`, defaulting to the safe values (on / off). (d) `ask_bot` is added in Task 16.

**Files:**
- Create: `src-tauri/src/chat/tools/bots.rs`
- Modify: `src-tauri/src/chat/tools/mod.rs` (constants + dispatch, mirroring the automations arm at automations.rs-tools:25-30)
- Modify: `src-tauri/src/chat/tools/specs.rs` (tool specs)
- Test: `#[cfg(test)]` in `src-tauri/src/chat/tools/bots.rs`

**Interfaces:**
- Consumes: `db::bots::*` (Task 1), the automations tool pattern (`chat/tools/automations.rs`: name constants, `dispatch`, `is_automation_tool` write-classification at :54, approval flow).
- Produces: tools `list_bots` (read-class), `create_bot` / `update_bot` / `delete_bot` / `run_bot` (write-class → approval-gated; **agent-created bots land `enabled = false`**, mirroring agent-created automations landing disabled).

- [ ] **Step 1: Constants + classification**

In `chat/tools/mod.rs` add name constants next to the automation ones (`LIST_BOTS, CREATE_BOT, UPDATE_BOT, DELETE_BOT, RUN_BOT` — same naming style as `CREATE_AUTOMATION` at :16). In `bots.rs`:

```rust
// Bots chat tools — the main-chat agent can inspect, create, edit, and run
// bots (docs/architecture/BOTS.md). Mirrors tools/automations.rs: read tools
// answer inline; write tools are write-classified (approval) and
// agent-created bots land DISABLED pending the owner's approval, exactly
// like agent-created automations.

pub fn is_bot_tool(name: &str) -> bool {
    matches!(name, LIST_BOTS | CREATE_BOT | UPDATE_BOT | DELETE_BOT | RUN_BOT)
}

pub fn is_bot_write_tool(name: &str) -> bool {
    matches!(name, CREATE_BOT | UPDATE_BOT | DELETE_BOT | RUN_BOT)
}
```

Register in the same match arms the automation tools use in `mod.rs` dispatch and the write-classification set (the :54 equivalent), so approval gating comes free.

- [ ] **Step 2: Tool handlers**

Each handler is `fn(app: &AppHandle, args: &Value) -> String` (same signature as automations.rs:353):
- `list_bots`: id, emoji, name, description, enabled, job count per bot. Empty roster → `"No bots exist yet. Create one with create_bot (name, persona…)"` (mirror the automations empty-state copy at automations.rs:106).
- `create_bot`: args `name` (required), `description`, `emoji`, `persona`, `model`; force `enabled: false` when `origin == "agent"`, and include in the reply: `"Bot 'Atlas' created (disabled — pending your approval in the Bots view)."` Emit `bots:changed` so the rail refreshes.
- `update_bot` / `delete_bot`: `bot_id` required; same emit-on-success. **Revision 2:** `update_bot` is a patch, so the model can rename with just `bot_id` + `name` and nothing else changes. Agent-origin updates **cannot set `enabled`** (the handler drops it): enabling is owner-only (Bots view, Task 15), otherwise an agent could approve its own creation. Name validation errors are returned to the model as the tool result so it can pick another name.
- `run_bot`: `bot_id` required, optional `prompt`. Resolves `ensure_bot_session`, then spawns the chat one-shot on its own thread exactly as `run_automation_now` does (reuse its spawn/stop bookkeeping — `automations::is_running`-style guard keyed by bot id to prevent overlapping runs). Returns `"Running in Atlas's thread — you'll see the reply there."`

- [ ] **Step 3: Tool specs**

In `specs.rs`, add specs following the automation entries (name, description, JSON-schema args). Descriptions:
- `list_bots`: `"List the user's bots (named persistent agents) with their status and jobs."`
- `create_bot`: `"Create a bot — a named agent with its own persona, memory, and thread. Created disabled until the user approves it in the Bots view."`
- `update_bot`: `"Update a bot's name, description, persona, model, or toggles by bot_id."`
- `delete_bot`: `"Delete a bot by bot_id. Its thread stays in chat history."`
- `run_bot`: `"Trigger a run of a bot now in its own thread; optional prompt overrides the standing job."`

- [ ] **Step 4: Tests**

```rust
#[test]
fn create_bot_tool_lands_agent_bots_disabled() {
    // in-memory conn + schema; call create_bot handler with origin agent;
    // assert the row has enabled = 0 and the reply mentions approval.
}

#[test]
fn bot_tool_classification() {
    assert!(is_bot_tool(LIST_BOTS));
    assert!(!is_bot_write_tool(LIST_BOTS));
    assert!(is_bot_write_tool(RUN_BOT));
}
```

Run: `cd src-tauri && cargo test bot_tool && cargo test create_bot_tool`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/chat/tools/bots.rs src-tauri/src/chat/tools/mod.rs src-tauri/src/chat/tools/specs.rs
git commit -m "feat(bots): chat tools — list/create/update/delete/run bots from main chat"
```

---

### Task 11: Mobile — Bots over the relay

**Revision 2 (Task 11): approvals are the point of the phone screen.** Add relay messages `ListBotApprovals` → `BotApprovalsList { approvals }` and `ResolveBotApproval { id, approve }` → `BotApprovalResolved { id, status }`, parallel to the `ListBots` arm; `BotInfo` gains `pendingApprovals: number`. `BotsScreen` rows show the gold dot and count; tapping opens an approval sheet (summary, tool name, read-only arguments, Approve / Deny). Reuse the existing Expo push path for "Atlas wants your approval: …" (emitted by Task 13 Step 7). Extend Step 5's verification: queue an approval on the desktop, approve it from the phone, confirm the action ran and the run session shows the result. Keep arguments in the sheet truncated, and never show values the tool dispatcher already redacts in logs.

**Files:**
- Modify: `src-tauri/src/mobile/relay.rs` (`MobileMessage` dispatch — copy the `ListAutomations` arm at 1984)
- Modify: `mobile/src/hooks/useRelay.ts` (`_send` type union at 1290 area; `EventBus` singletons at 427-428 / 1034-1059; hook returns at 1350)
- Create: `mobile/src/screens/BotsScreen.tsx`
- Modify: `mobile/App.tsx` (imports 14-30; `HomeStack.Screen` block 41-53)

**Interfaces:**
- Consumes: relay protocol (type-tagged JSON over the encrypted socket), `db::bots::list_bots`.
- Produces: relay messages `ListBots` → reply `BotsList { bots: BotInfo[] }`; `BotsScreen`; nav entry "Bots".

- [ ] **Step 1: Desktop relay arm**

In relay.rs's `MobileMessage` enum add `ListBots`, and in the dispatch add an arm exactly parallel to `ListAutomations` (1984): lock the db, `db::bots::list_bots(&conn)`, serialize with the same serde camelCase as every other reply frame, send back as `BotsList { bots }`. Use whichever reply helper the adjacent arm uses — do not invent a new frame format.

- [ ] **Step 2: Mobile client wiring**

useRelay.ts:
- Type: add `| { type: 'ListBots' }` to the `_send` message union.
- `export const onBotsList = new EventBus<{ bots: BotInfo[] }>();` next to `onAutomationList` (427-428).
- Reply dispatch: in the same switch that routes `AutomationList` → `onAutomationList.emit(...)` (1034-1059), route `BotsList` → `onBotsList.emit`.
- Hook return: `listBots: () => _send({ type: 'ListBots' })` next to `listAutomations` (1350).
- `BotInfo` interface wherever `AutomationInfo` lives: mirror the desktop `Bot` camelCase fields (id, name, description, emoji, color, enabled).

- [ ] **Step 3: `BotsScreen.tsx`**

Pattern-match `AutomationsScreen.tsx` (destructure from `useRelay()` at :66, `onBotsList.on(...)` subscription at :102, `useRelayList` refresh at :93). Render:
- A row per bot: dot (color from `bot.color`), emoji + name, description as the dim second line, and a "working" pulse dot when an automation with that `botId` is currently running (reuse the subscription `AutomationsScreen` uses for run events).
- Tapping a row opens `SessionChat` against the bot's thread (the session mapping already maps phone session ids to desktop sessions — request the bot's session the same way run logs open).
- Empty state: "No bots yet. Create one in Relay's Bots view on your desktop."

- [ ] **Step 4: Register the screen**

App.tsx: `import BotsScreen from './src/screens/BotsScreen';` + `<HomeStack.Screen name="Bots" component={BotsScreen} />` after the Automations entry.

- [ ] **Step 5: Verify over the real relay**

Pair the Expo app (dev client) to a running desktop instance; confirm: Bots tab lists the desktop's bots, dot colors match, tapping a bot opens its thread, and a cron-fired bot job pushes a completion notification through the existing Expo push path (`mobile/push.rs` already forwards automation events).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/mobile/relay.rs mobile/src/hooks/useRelay.ts mobile/src/screens/BotsScreen.tsx mobile/App.tsx
git commit -m "feat(bots): mobile bot list + bot thread over the relay"
```

---

### Task 12: Docs

**Revision 2 (Task 12):** `docs/architecture/BOTS.md` must also document: the thread-vs-run model and Chat History filtering; the background permission policy and the approval lifecycle (including the 72-hour expiry and the Preflight finding on today's headless tool behavior); delete semantics; the `tools_enabled` / `enabled` / `inherit_global_prompt` / `memory_read_default` semantics; the scheduler-availability badge and the missed-run (coalesce) policy; the Session Mesh decision table from Task 16, and rename semantics (names unique ignoring case, 1–40 characters; the thread title follows a rename or emoji change; run-session titles and memories written under an old name are history and are not rewritten). Write it last so it describes what shipped.

**Files:**
- Create: `docs/architecture/BOTS.md`
- Modify: `docs/ai-context/AI_CONTEXT.md` (code-map entries: db/bots.rs, commands/bot_cmds.rs, chat/tools/bots.rs, components/bots/BotsView.tsx, BotEditorModal.tsx, BotsScreen)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write `docs/architecture/BOTS.md`**

Status header per the architecture-folder convention ("Status headers state what shipped"). Sections: identity model (dot + emoji + description; persona layers on the global prompt via `compose_prompt`, `inherit_global_prompt` opt-out, empty persona = a shell over the global prompt), thread model (one lazy `'thread'` session per bot via `ensure_bot_session`; the Bots view mounts the real ChatView on it; threads appear in Chat History like any session; run sessions are separate and hidden), memory scoping (`bot:<id>` profile namespace, `Bot.memory_enabled` gate, `memory_read_default` read-through, visibility in the editor), jobs (bot-bound automations run in their own run sessions; run-while-closed via the existing schtasks path, Windows only until Task 17), main-chat tools (read/write classification, agent-created bots land disabled pending approval), surfaces (Bots view, BotEditorModal, mobile), and the explicit non-goals (no per-bot sandboxed computer, no connector directory, no settings-page editor, no bot-created bots).

- [ ] **Step 2: AI_CONTEXT + CHANGELOG**

Add the new files to the AI_CONTEXT.md code map with one-line descriptions; CHANGELOG entry under Unreleased → Added.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/BOTS.md docs/ai-context/AI_CONTEXT.md CHANGELOG.md
git commit -m "docs(bots): architecture doc + code map + changelog"
```

---

### Task 13: Background-run permission policy + approval inbox (Revision 2)

**Files:**
- Modify: `src-tauri/src/db/mod.rs` (`bot_approvals` table in `init_schema`; `pub mod bot_approvals;`)
- Create: `src-tauri/src/db/bot_approvals.rs` (queue / list / resolve / expire)
- Create: `src-tauri/src/chat/bot_policy.rs` (pure gate function + summary builder + tests)
- Modify: the tool dispatcher's write-approval point (start from `is_automation_tool` in `chat/tools/automations.rs:54` and follow its caller)
- Modify: `src-tauri/src/chat/mod.rs` (`run_one_shot_chat` carries a `RunOrigin`), `src-tauri/src/commands/bot_cmds.rs` (`list_bot_approvals`, `resolve_bot_approval`)
- Create: `src/components/bots/ApprovalInbox.tsx`; Modify: `src/components/bots/BotsView.tsx`, `src/lib/ipc/bots.ts`, `src/hooks/useBots.ts`
- Test: `#[cfg(test)]` in `bot_approvals.rs` and `bot_policy.rs`; `src/test/approvalInbox.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`Bot`, `create_bot_run_session`), Task 9 (background run entry point), the existing write-class tool classification.
- Produces: `RunOrigin::{Interactive, Background}`; `Gate::{Allow, QueueApproval, Deny}`; `bot_policy::gate(origin, is_write_class, bot_tools_enabled) -> Gate`; `bot_policy::summarize_tool_call(name, args) -> String`; `bot_approvals` rows; `bots:changed` gains action `"approval"`.

**The rule:** a background run (standing job, `run_bot`, `ask_bot`, a future webhook-delivered turn) never executes a write-class tool. Read-class tools run. Write-class calls are queued for the owner. The gate applies only to sessions that have a `bot_id`; every other session behaves exactly as today.

- [ ] **Step 1: Preflight — how do headless runs treat write-class tools today?**

Run: `grep -rn "run_one_shot_chat" src-tauri/src` and read the tool-approval path it reaches. Record the answer (auto-allow, auto-deny, or hang) in `docs/architecture/BOTS.md`. Do not change non-bot behavior; if it auto-allows, note it in the CHANGELOG as an existing gap.

- [ ] **Step 2: Schema**

In `init_schema`, after the `bots` table:

```sql
CREATE TABLE IF NOT EXISTS bot_approvals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  run_session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  summary TEXT NOT NULL,                  -- deterministic, see summarize_tool_call
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | expired | failed
  result TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bot_approvals_bot_status ON bot_approvals(bot_id, status);
```

`delete_bot` (Task 1) also deletes the bot's `bot_approvals` rows inside its transaction.

- [ ] **Step 3: The policy, written test-first**

```rust
// chat/bot_policy.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOrigin { Interactive, Background }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate { Allow, QueueApproval, Deny }

/// Allow = proceed on the normal path (interactive turns keep their existing
/// approval UX). Only consulted for sessions that belong to a bot.
pub fn gate(origin: RunOrigin, is_write_class: bool, bot_tools_enabled: bool) -> Gate {
    if !bot_tools_enabled { return Gate::Deny; }
    match (origin, is_write_class) {
        (RunOrigin::Interactive, _) => Gate::Allow,
        (RunOrigin::Background, false) => Gate::Allow,
        (RunOrigin::Background, true) => Gate::QueueApproval,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn background_write_is_queued() {
        assert_eq!(gate(RunOrigin::Background, true, true), Gate::QueueApproval);
    }
    #[test] fn background_read_runs() {
        assert_eq!(gate(RunOrigin::Background, false, true), Gate::Allow);
    }
    #[test] fn interactive_is_unchanged() {
        assert_eq!(gate(RunOrigin::Interactive, true, true), Gate::Allow);
    }
    #[test] fn tools_disabled_denies_everything() {
        assert_eq!(gate(RunOrigin::Interactive, false, false), Gate::Deny);
    }
}
```

`summarize_tool_call(name, args)` builds the one-line summary **from the tool spec's declared primary arguments** (for example `Create vault note "Standup" in Daily/`), falling back to `"<tool_name> (N arguments)"`. It is never model-written text, so a prompt-injected run cannot disguise what it is asking for. Test: two calls with the same args produce byte-identical summaries.

- [ ] **Step 4: Wire the gate**

1. `run_one_shot_chat` takes a `RunOrigin` (add it to the existing run-context struct if there is one; otherwise one new parameter). Bot-bound automation runs, `run_bot` and `ask_bot` pass `Background`; the interactive `send` path implies `Interactive`.
2. At the dispatcher's write-approval point: if the session has a `bot_id` and origin is `Background`, call `gate(...)`. On `QueueApproval`: insert the `bot_approvals` row, emit `bots:changed { action: "approval" }`, and return this tool result to the model: `"Queued for the owner's approval (id <id>). Do not retry this action; finish the rest of the task and mention it in your summary."` (This stops the model looping on a refused tool.) On `Deny`: return `"Tools are disabled for this bot."`
3. Non-bot sessions never reach the gate.

- [ ] **Step 5: Resolve**

`resolve_bot_approval(id, approve)`:
- `approve`: replay the stored `args_json` verbatim through the same dispatcher with the gate bypassed for exactly this one call; store the result string; status `approved`, or `failed` with the error if the target changed underneath it (file gone, branch moved). Append a short note to the run session (`✓ Approved: <summary> → <result>`) so history stays truthful.
- `deny`: status `denied`; note appended the same way.
- Expiry: pending rows older than 72 hours become `expired` (sweep on app start and on every list call). Stale approvals are a hazard, not a convenience.

- [ ] **Step 6: Inbox UI**

`ApprovalInbox.tsx`: a "Needs approval (N)" section in the bot's activity area (above the jobs strip, Task 9 Step 5). Each row: summary, tool name, relative time, **Approve** / **Deny**, and an expandable read-only view of the arguments. The bot's rail dot turns `--state-waiting` (gold) while any row is pending. Rows store `bot_id` only and the list joins `bots` for the **current** name (push text is built at send time the same way), so a rename never leaves a stale label. Vitest: renders rows, approve/deny call the IPC, the gold state follows the pending count.

- [ ] **Step 7: Notify**

When a row is queued, emit the same desktop notification used for automation completion and forward it through the existing Expo push path (`mobile/push.rs`): "Atlas wants your approval: <summary>". Resolution from the phone is Task 11.

- [ ] **Step 8: Verify**

Manual: create a bot with a cron job whose prompt asks it to create a Vault note.
1. Run now → a pending approval appears, no note exists, the run session shows the queued-tool result.
2. Approve → the note is created and the run session shows the ✓ note.
3. Repeat and Deny → no note.
4. Set a row's `created_at` 73 hours back → it shows as expired and cannot be approved.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/db/ src-tauri/src/chat/ src-tauri/src/commands/bot_cmds.rs src/components/bots/ApprovalInbox.tsx src/components/bots/BotsView.tsx src/lib/ipc/bots.ts src/hooks/useBots.ts src/test/approvalInbox.test.tsx
git commit -m "feat(bots): background runs queue write actions for approval"
```

---

### Task 14: Run sessions + activity strip (Revision 2)

**Files:**
- Modify: `src-tauri/src/db/bots.rs` (`post_run_summary`, `prune_runs`, `list_bot_runs`)
- Modify: the chat-history list query (find via `grep -rn "list_chat_sessions" src-tauri/src`) and `src-tauri/src/automations.rs` (call the summary after a run)
- Modify: `src-tauri/src/commands/bot_cmds.rs` (`list_bot_runs`)
- Create: `src/components/bots/RunsStrip.tsx`; Modify: `src/components/bots/BotsView.tsx`, `src/lib/ipc/bots.ts`
- Test: `#[cfg(test)]` in `db/bots.rs`; `src/test/runsStrip.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`create_bot_run_session`, `bot_role`), Task 3 (`bot_job_id`), Task 9 (runs happen), Task 13 (pending approval counts).
- Produces: `post_run_summary(conn, bot_id, run_session_id, status, text)`; `prune_runs(conn, bot_id, keep)`; `list_bot_runs(bot_id, limit) -> Vec<BotRun>` where `BotRun { sessionId, jobId, jobName, status, startedAt, finishedAt, pendingApprovals }`.

Job output no longer lands in the conversation the user talks in. The thread stays a conversation; runs are an activity log you can open.

- [ ] **Step 1: Hide run sessions from Chat History.** The history list excludes `bot_role = 'run'`. Bot threads (`'thread'`) stay visible, as the original design promised. Test: a run session never appears in the history list; the thread does.

- [ ] **Step 2: Post one summary to the thread.** After a bot-bound run finishes (success, failure or cancel), append a single compact assistant message to the bot's thread: job name, time, status, the first ~400 characters of the run's final assistant message (clearly marked as an excerpt, not a model-written summary), and an "Open run" affordance carrying the run session id in message metadata. Preflight: find the message-insert helper the automation run log or one-shot path already uses and reuse it. Test: exactly one summary per run, in the thread, not in the run session.

- [ ] **Step 3: Retention.** `prune_runs(conn, bot_id, 50)` after each run deletes the oldest run sessions beyond the newest 50 per bot (messages included, using the existing session-delete path). The bound is a constant for now; make it a setting only if someone asks.

- [ ] **Step 4: `list_bot_runs`.** Joins run sessions to the existing automation run records for status and timings (find the run table via `grep -n "CREATE TABLE.*automation" src-tauri/src/db/mod.rs`) and to `bot_approvals` for the pending count.

- [ ] **Step 5: `RunsStrip.tsx`.** In the bot's activity area (next to the jobs strip and the approval inbox): a list of recent runs — job name, start time, duration, state dot (`--state-working` while running, gold if the run has pending approvals, idle otherwise). Clicking a run calls `selectSession(runSessionId)` so it opens in the same real `ChatView`. Vitest: renders runs, selection calls `selectSession`, the working dot follows the running event.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/bots.rs src-tauri/src/automations.rs src-tauri/src/commands/bot_cmds.rs src/components/bots/RunsStrip.tsx src/components/bots/BotsView.tsx src/lib/ipc/bots.ts src/test/runsStrip.test.tsx
git commit -m "feat(bots): per-run sessions, thread summaries, activity strip"
```

---

### Task 15: Toggles with teeth (Revision 2)

**Files:**
- Modify: `src-tauri/src/db/bots.rs` (`tools_allowed`), `src-tauri/src/chat/commands/send.rs` and `src-tauri/src/chat/mod.rs` (tool-set assembly), `src-tauri/src/automations.rs` (`prepare_bot_run` already refuses disabled bots)
- Modify: `src/components/bots/BotsView.tsx` (Approve action, dimmed row)
- Test: `#[cfg(test)]` in `db/bots.rs` and `automations.rs`; `src/test/botsView.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`Bot.tools_enabled`, `Bot.enabled`), Task 13 (`gate` already denies when tools are off).
- Produces: `db::bots::tools_allowed(conn, chat_session_id) -> bool` (true for non-bot sessions).

**Semantics, written once (copy into BOTS.md):**
- `tools_enabled = false`: the bot's turns, in its thread and in runs, are assembled with an **empty tool set**. The bot is chat-only. This is also the safest way to run a persona that should never act.
- `enabled = false`: the bot's standing jobs are skipped by the scheduler (including `relay-automation run-due`), `run_bot` and `ask_bot` refuse, mobile shows the row dimmed. **The thread stays usable**, so an agent-created bot (which lands disabled) can be talked to and reviewed before it is approved.

- [ ] **Step 1: Preflight.** Find where the tool spec list is assembled for a turn (`grep -rn "specs::" src-tauri/src/chat`). Both paths (live send and one-shot) must apply `tools_allowed`.
- [ ] **Step 2: Failing tests.** `tools_allowed` is true for a non-bot session, true for a bot with tools on, false with tools off. A disabled bot's `prepare_bot_run` returns an error and no run session is created. A disabled bot's thread still accepts a send.
- [ ] **Step 3: Implement** the empty tool set at both assembly points, guarded by `tools_allowed`, so non-bot sessions take the existing branch untouched.
- [ ] **Step 4: Approve action.** A disabled bot's rail row is dimmed with a "Waiting for your approval" badge and an **Approve** button that calls `set_bot_enabled(true)`. Agent-created bots (Task 10) are the main case.
- [ ] **Step 5: Run** `cd src-tauri && cargo test` and `npm test`. Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/bots.rs src-tauri/src/chat/ src-tauri/src/automations.rs src/components/bots/BotsView.tsx src/test/botsView.test.tsx
git commit -m "feat(bots): enforce tools_enabled and define enabled semantics"
```

---

### Task 16: Harness bridge — `ask_bot` + Session Mesh access (Revision 2)

> **Status: design-light on purpose.** This task connects bots to the CLI agent panes, which is Relay's differentiator, but it depends on Session Mesh internals this plan's author has not seen. The first step is reading; the remaining steps are the contract, not the code. Expand this task into code-level steps once Step 1 is done.

**Files:**
- Read: `docs/architecture/SESSION_MESH_DESIGN_ARCHITECTURE.md`, `src-tauri/src/session_fabric/`
- Modify: `src-tauri/src/chat/tools/bots.rs` (`ask_bot`), `src-tauri/src/chat/tools/mod.rs` + `specs.rs` (constant, dispatch, spec)
- Modify: the tool registry so bot sessions can reach the mesh tools (subject to Task 13's gate and Task 15's `tools_enabled`)
- Test: `#[cfg(test)]` in `chat/tools/bots.rs`

**Interfaces:**
- Consumes: Task 1 (`create_bot_run_session`), Task 13 (`RunOrigin::Background` gate).
- Produces: tool `ask_bot(bot_id, question)`; bot access to the mesh's list / message / spawn operations.

- [ ] **Step 1: Read the Session Mesh doc and code.** List its operations (awareness, messaging, spawning) and how each is classified today. Decide which a bot may call. Write the decision table into `docs/architecture/BOTS.md`.
- [ ] **Step 2: `ask_bot`.** Main chat hands a question to a bot: create a run session, run one turn with `RunOrigin::Background`, return the answer text (timeout 120 s, cancellable). It is **read-class** because the Task 13 gate already prevents the delegated run from writing; the user is not asked to approve a question. It consumes the local-model queue at `Background` priority (Task 17).
- [ ] **Step 3: Mesh access for bots.** Reading and messaging operations are allowed for bot sessions. **Spawning an agent pane is write-class**, so in a background run it queues an approval ("Atlas wants to start Claude Code in a worktree: <prompt>"). That is how a standing job hands work to the harness without ever acting unattended.
- [ ] **Step 4: One shipped example.** The empty state offers a "Repo watcher" template: a cron or git-HEAD trigger, read-only checks, and a queued "spawn an agent to fix this" approval. It demonstrates the whole loop (standing job → inbox → harness) in one card.
- [ ] **Step 5: Tests.** `ask_bot` returns the bot's answer in a run session and appends nothing to the thread except the Task 14 summary; `ask_bot` on a disabled bot is refused; a background spawn call queues instead of spawning.
- [ ] **Step 6: Commit** `feat(bots): ask_bot delegation and harness access via Session Mesh`

---

### Task 17: Scheduler honesty, local-model priority, run-while-closed parity (Revision 2)

**Files:**
- Modify: `src-tauri/src/local_models.rs` (queue priority)
- Create: `src-tauri/src/commands/bot_cmds.rs` addition `scheduler_available() -> bool`
- Modify: `src/components/bots/BotsView.tsx` (badge), the automation scheduler registration code (mirror the Windows sidecar path; find under `scripts/` and `src-tauri/src/automations*`)
- Test: `#[cfg(test)]` in `local_models.rs`; `src/test/botsView.test.tsx`

**Interfaces:**
- Produces: `Priority::{Interactive, Background}` on local-model requests; command `scheduler_available`.

- [ ] **Step 1: Queue priority (P0).** One local model runs at a time, so a 9 a.m. cron job must not make the user's own chat wait. Read the queue in `local_models.rs`. Add `Priority`: a `Background` request waits while any `Interactive` request is queued or running, and never preempts mid-generation (it simply starts later). Bot runs, `run_bot` and `ask_bot` use `Background`; the composer and live send use `Interactive`. Test with a fake queue: an interactive request enqueued after a background one is served first when both are waiting; a running background request is not interrupted.
- [ ] **Step 2: Honest badge (P0, can ship with Task 7).** `scheduler_available()` is true only where a run-while-closed mechanism is registered (Windows Task Scheduler sidecar today). When false, the Bots view shows "Standing jobs run only while Relay is open" in the activity area, and all UI copy says "standing jobs" rather than "always-on".
- [ ] **Step 3: macOS and Linux parity (P2).** macOS: a launchd agent (`dev.relay.automations.plist`, `StartInterval` 60) running `relay-automation run-due`. Linux: a `systemd --user` timer and service doing the same. Mirror the Windows registration code path and its uninstall behavior. **Missed-run policy: coalesce.** After sleep or downtime, a job runs once on wake, not once per missed tick. Document the policy in BOTS.md.
- [ ] **Step 4: Verify.** Windows: unchanged behavior. macOS/Linux: register, close Relay, confirm a cron bot job fires and its run session and approval queue appear on next open. `scheduler_available` is true afterwards.
- [ ] **Step 5: Commit** `feat(bots): local-model priority, scheduler honesty badge, run-while-closed parity`

---

## Follow-ups (deliberately NOT in this plan)

- **Composer chip ("bind any chat to a bot persona")**: letting a *regular* chat borrow a bot's persona. Deferred — v1 keeps bot personas scoped to the bot's own thread; revisit if users ask for persona overlays.
- **Webhook → bot channel**: deliver an external POST as a message and trigger a turn. Revision 2: inbound text is untrusted input, so these turns are `Background`-origin (Task 13) and run in a run session, not in the thread.
- **Custom sprites** (image avatars) beyond emoji in the rail/modal.
- ~~**`ask_bot` delegate tool**~~ — promoted to Task 16 (Revision 2).
- **Per-bot tool allowlists** narrower than the global cap-state tool set.
- **Mobile bot creation** once the modal form is worth porting.

## Self-Review

- Spec coverage vs. the user's 2026-10-04 design: header entry + dedicated view (Task 7), left rail with name/emoji/description (Tasks 1, 7), center = the chat view for bots (Task 7 — the real ChatView on the bot's session), empty-state create promo + popup editor shared away from Settings (Tasks 7, 8), main-chat management tools read/write/run (Task 10) — all present; persona/memory/jobs carry over unchanged (Tasks 4, 5, 9).
- Placeholder scan: no TBDs; the two "mirror the neighboring code" instructions (migration error-matching, relay reply helper) name the exact file:line to copy; the ChatView mock note in the view test explains the jsdom stub.
- Type consistency: `Bot`/`BotInput` camelCase end-to-end (Rust serde ↔ TS, now including `description`); `ensure_bot_session` / `persona_for_session` / `bot_memory_profile` / `prepare_bot_run` names match across Tasks 1, 3, 4, 5, 7, 9; event name `bots:changed` matches in Tasks 2, 6, 7, 10; tool names `list_bots`/`create_bot`/`update_bot`/`delete_bot`/`run_bot` match the automations-tool naming family.
- **Revision 2 coverage (2026-10-14):** unattended permissions → Task 13; "always-on" honesty, queue priority, scheduler parity → Task 17; dead toggles → Tasks 1, 15; thread/run split → Tasks 1, 3, 9, 14; delete semantics and the single NULL sentinel → Tasks 1, 2, 8; memory visibility and read-through → Tasks 5, 8; persona layering → Tasks 1, 4, 8; harness bridge → Task 16; market-fact corrections → Design; provider hard-code and the Task 4 compile error → Tasks 1, 4; anchor drift → Preflight.
- **Known unknowns, by design:** Tasks 13–17 begin with Preflight greps because this revision was written from the plan and the repo README, without source access. They name the thing to find, not a line number. Task 16 is explicitly design-light until Session Mesh has been read. The two `get_setting` keys in `seed_provider_model` and the `advance_cursor_to_latest` helper in `delete_bot` are placeholders to confirm against the repo.
- **Type consistency (Revision 2):** `Bot` / `BotInput` gain `inheritGlobalPrompt` and `memoryReadDefault` end-to-end; `ChatSession` gains `botRole` and `botJobId`; `Automation.botId` is `string | null`; new names `create_bot_run_session`, `resolve_custom_prompt`, `compose_prompt`, `DeleteBotOutcome`, `RunOrigin`, `Gate`, `bot_approvals` match across Tasks 1–5, 9–11 and 13–17.
- **Rename addendum (2026-10-14):** `update_bot` is now a patch (`BotPatch`), names are validated and unique ignoring case, the thread title follows renames, agent-origin updates cannot set `enabled`, and everything else references bots by id → Tasks 1, 2, 6, 7, 8, 10, 13.
