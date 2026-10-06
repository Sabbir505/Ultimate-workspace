# Bots (Always-On Agents) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named persistent agents ("Bots") — each with its own persona, memory scope, standing jobs, and its own conversation — surfaced as a first-class **Bots view** (like Vault/Automations/Wiki) with a bot rail on the left and the real ChatView in the center, plus chat tools (`list_bots`, `create_bot`, `update_bot`, `run_bot`) so the main chat can manage bots conversationally.

**Architecture:** A `bots` SQLite table holds the agent identity (name, emoji, description, persona prompt, model, toggles). Each bot owns one lazily-created chat session (`chat_sessions.bot_id`) — its thread. The Bots view mounts the **real `ChatView`** bound to the bot's session (same store, same pane component — no bespoke renderer), so bot threads are also openable from normal chat history. Bot memory reuses the memory `profile` namespace as `bot:<id>`. `automations.bot_id` turns a trigger into a bot's standing job. Agent-facing chat tools mirror the automations tool family, with write tools landing disabled pending approval. There is **no Settings page for bots** — the editor is a modal opened from the Bots view.

**Tech Stack:** Rust/Tauri (rusqlite, existing automations scheduler + memory worker + tool registry), TypeScript/React (existing view/view-nav patterns, `ChatView` main-pane reuse), Vitest (frontend), `#[cfg(test)]` rusqlite tests (backend).

**Spec:** Design rationale in the "Design" section below; visual spec at `docs/superpowers/specs/2026-10-04-bots-design-mockup.html` (open in a browser — Surface 01 is the Bots view, Surface 02 the empty state + create modal, Surface 03 the main-chat tools, Surface 04 mobile).

## Design (why it looks like this)

- **A bot is a named entity, not a chat — but you talk to it in a chat.** Market framing (OpenAI Dots, Meta Muse, xAI Grok Bot, Sept 2026): identity + memory + standing jobs + reachable anytime. Relay's differentiator: everything runs on the user's own machine — no per-agent cloud VM, no $100/mo.
- **The Bots view is a destination, like Vault/Automations/Wiki** (user decision, 2026-10-04): new `ActiveView` member `"bots"`, entry in the sidebar Global Views block, full center-area swap in `App.tsx`. Left rail = roster (dot, emoji/sprite, name, one-line description, live status dot). Center = the bot's conversation.
- **The center IS the real `ChatView`.** `ChatView()` with no props renders the active session from the chat store (`ChatPaneGrid.tsx:76` mounts it exactly this way for the main pane). Selecting a bot in the rail calls `selectSession(botSessionId)` and renders `<ChatView />`. Bot threads therefore get streaming, tools, approvals, artifacts, checkpoints, TTS for free — and remain openable from Chat History like any session. Never build a second message renderer.
- **No settings page.** Creating/editing a bot happens in a `BotEditorModal` opened from the Bots view (empty-state promo card and the "New bot" rail button both open it). The persona-replaces-global-prompt rule still applies to the bot's own thread.
- **Main chat manages bots via tools**, mirroring `chat/tools/automations.rs`: `list_bots` (read), `create_bot` / `update_bot` / `delete_bot` (write-classified — agent-created bots land `enabled = 0` pending approval, same as agent-created automations), `run_bot` (write-classified — triggers a turn in the bot's session now).
- **Visual identity = the dot.** Bots render as a colored dot + emoji (Relay's state-dot language: `--state-working` teal, `--state-waiting` gold, `--state-idle` gray). The dot pulses while a job runs. Custom sprite images are a follow-up; v1 ships emoji.

## Global Constraints

- **No new dependencies** — no new crates in `src-tauri/Cargo.toml`, no new npm packages.
- All new wire types use `#[serde(rename_all = "camelCase")]`; all event payloads use camelCase keys.
- **The Bots view center mounts the real `ChatView`** — no bespoke message list, no forked composer.
- **Non-bot sessions must be unchanged**: when `chat_sessions.bot_id` is NULL, the send path, memory pipeline, and prompt-cache warmup behave exactly as today.
- **No bot CRUD in Settings** — the modal is the only editor.
- Bot memory is a memory `profile` value `bot:<botId>`; the user-facing MemoryPanel keeps reading profile `default` only.
- Follow the existing migration pattern (`ALTER TABLE … ADD COLUMN` + swallow "duplicate column name", registered in `db::configure`).
- Windows run-while-closed (`relay-automation run-due` → `run_blocking`) must keep working for bot-bound automations.
- One local model at a time (v1 policy, `local_models.rs`) — bot jobs on LocalGguf share the same sidecar queue as chats.
- Agent-created bots land **disabled** pending approval (mirror the agent-created-automation behavior in `chat/tools/automations.rs`).
- Copy style: sentence case, active verbs ("New bot", "Run now").

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

---

### Task 1: DB schema + Bot CRUD

**Files:**
- Modify: `src-tauri/src/db/mod.rs` (init_schema at 1079; configure at ~410; migration pattern at 262)
- Create: `src-tauri/src/db/bots.rs`
- Modify: `src-tauri/src/db/mod.rs` (`pub mod bots;` — module list near the top)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Bot`, `BotInput` (serde camelCase), `create_bot(conn, &BotInput) -> DbResult<Bot>`, `get_bot(conn, id) -> DbResult<Option<Bot>>`, `list_bots(conn) -> DbResult<Vec<Bot>>`, `update_bot(conn, id, &BotInput) -> DbResult<Bot>`, `delete_bot(conn, id) -> DbResult<()>`, `set_bot_enabled(conn, id, bool) -> DbResult<()>`, `ensure_bot_session(conn, bot_id) -> DbResult<String>`, `persona_for_session(conn, chat_session_id) -> DbResult<Option<String>>`, `bot_memory_profile(bot_id: &str) -> String` (returns `bot:<id>`). Later tasks import exactly these.

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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Add the two column migrations**

Copy the `migrate_automations_origin` pattern (db/mod.rs:262 — `ALTER TABLE` + swallow the "duplicate column name" error; mirror that function's exact error-match shape). Add both functions next to it, and register them in `configure()` (line ~446 block) after `migrate_automations_triggers(conn)?;`:

```rust
fn migrate_chat_sessions_bot_id(conn: &Connection) -> DbResult<()> {
    // ALTER TABLE chat_sessions ADD COLUMN bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL
}

fn migrate_automations_bot_id(conn: &Connection) -> DbResult<()> {
    // ALTER TABLE automations ADD COLUMN bot_id TEXT NOT NULL DEFAULT ''
}
```

(The two statements above are the only delta from the neighboring migrations — read `migrate_automations_origin` first and mirror it.)

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
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn create_bot(conn: &Connection, input: &BotInput) -> DbResult<Bot> {
    let id = super::new_id("bot");
    let now = now_ts();
    conn.execute(
        "INSERT INTO bots (id, name, description, emoji, color, system_prompt, provider,
                           model, tools_enabled, memory_enabled, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            input.name.trim(),
            input.description.as_deref().unwrap_or(""),
            input.emoji.as_deref().unwrap_or("🤖"),
            input.color.as_deref().unwrap_or(""),
            input.system_prompt.as_deref().unwrap_or(""),
            input.provider.as_deref().unwrap_or(""),
            input.model.as_deref().unwrap_or(""),
            input.tools_enabled.unwrap_or(true) as i64,
            input.memory_enabled.unwrap_or(true) as i64,
            input.enabled.unwrap_or(true) as i64,
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

pub fn update_bot(conn: &Connection, bot_id: &str, input: &BotInput) -> DbResult<Bot> {
    conn.execute(
        "UPDATE bots SET name = ?2, description = ?3, emoji = ?4, color = ?5,
                         system_prompt = ?6, provider = ?7, model = ?8,
                         tools_enabled = ?9, memory_enabled = ?10, enabled = ?11,
                         updated_at = ?12
         WHERE id = ?1",
        params![
            bot_id,
            input.name.trim(),
            input.description.as_deref().unwrap_or(""),
            input.emoji.as_deref().unwrap_or("🤖"),
            input.color.as_deref().unwrap_or(""),
            input.system_prompt.as_deref().unwrap_or(""),
            input.provider.as_deref().unwrap_or(""),
            input.model.as_deref().unwrap_or(""),
            input.tools_enabled.unwrap_or(true) as i64,
            input.memory_enabled.unwrap_or(true) as i64,
            input.enabled.unwrap_or(true) as i64,
            now_ts(),
        ],
    )?;
    Ok(get_bot(conn, bot_id)?.expect("bot exists"))
}

pub fn delete_bot(conn: &Connection, bot_id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM bots WHERE id = ?1", params![bot_id])?;
    Ok(())
}

pub fn set_bot_enabled(conn: &Connection, bot_id: &str, enabled: bool) -> DbResult<()> {
    conn.execute(
        "UPDATE bots SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
        params![bot_id, enabled as i64, now_ts()],
    )?;
    Ok(())
}

/// The bot's one conversation, created lazily and bound to the bot via
/// chat_sessions.bot_id — the Bots view opens it, bot-bound automations run
/// inside it. Reused across opens/runs so the thread is continuous.
pub fn ensure_bot_session(conn: &Connection, bot_id: &str) -> DbResult<String> {
    let mut stmt = conn.prepare(
        "SELECT s.id FROM chat_sessions s
         JOIN bots b ON b.id = s.bot_id
         WHERE b.id = ?1
         ORDER BY s.created_at DESC LIMIT 1",
    )?;
    if let Some(sid) = stmt.query_row(params![bot_id], |r| r.get::<_, String>(0)).optional()? {
        return Ok(sid);
    }
    let bot = get_bot(conn, bot_id)?.ok_or_else(|| {
        rusqlite::Error::InvalidParameterName(format!("bot not found: {bot_id}"))
    })?;
    let title = format!("{} {}", bot.emoji, bot.name);
    let session = super::create_chat_session_named(conn, "openai", "", Some(&title), None)?;
    super::chat::set_chat_session_bot(conn, &session.id, Some(bot_id))?;
    Ok(session.id)
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
        let bot = update_bot(&c, &bot.id, &upd).unwrap();
        assert_eq!(bot.name, "Atlas v2");
        assert!(!bot.enabled);
        assert_eq!(get_bot(&c, &bot.id).unwrap().unwrap().name, "Atlas v2");

        delete_bot(&c, &bot.id).unwrap();
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
        delete_bot(&c, &bot.id).unwrap();
        assert!(super::super::get_chat_session(&c, &sid).unwrap().is_some());
    }
}
```

- [ ] **Step 6: Run tests**

Run: `cd src-tauri && cargo test db::bots`
Expected: PASS (4 tests; tests 2–4 compile once `set_chat_session_bot` from Task 3 exists — land Task 3's Step 3 fn first if needed).

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
- Produces: commands `list_bots`, `create_bot(input: BotInput)`, `update_bot(bot_id: String, input: BotInput)`, `delete_bot(bot_id: String)`, `set_bot_enabled(bot_id: String, enabled: bool)`, `ensure_bot_session(bot_id: String) -> String` (session id) — all camelCase-invocable from the frontend; event `bots:changed` with payload `{ action: "created" | "updated" | "deleted", botId: string }`.

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

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test db::chat`
Expected: PASS, including the pre-existing suite.

- [ ] **Step 5: TS type**

In `src/lib/ipc/chatSessions.ts`, add to the `ChatSession` interface (after `agent?`):

```typescript
  /** The bot this thread belongs to (persona + memory + jobs). Only the
   *  bot's own session carries this. null = plain chat. Persisted. */
  botId?: string | null;
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
- Consumes: `db::bots::persona_for_session` (Task 1).
- Produces: behavioral contract — the bot's own session (any session with `bot_id`) uses the bot's `system_prompt` as the `custom` argument to `build_system_prompt`; everything else unchanged.

- [ ] **Step 1: Live send path**

Replace send.rs:1150 (`let custom = db::get_setting(&conn, "assistant.systemPrompt")…`) with:

```rust
        // Persona: a bot's own thread replaces the global assistant prompt.
        // Empty bot prompt → global setting (bot is a shell, not a persona).
        let custom = db::bots::persona_for_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .or_else(|| {
                db::get_setting(&conn, "assistant.systemPrompt").map_err(|e| e.to_string())?
            });
```

(`chat_session_id` is already in scope in this function — it's the same variable persisted per turn.)

- [ ] **Step 2: One-shot path (automations, bot jobs, headless runs)**

Replace mod.rs:2277-2283 with:

```rust
    let system_prompt = {
        let conn = db.lock();
        crate::db::bots::persona_for_session(&conn, chat_session_id)
            .ok()
            .flatten()
            .or_else(|| {
                crate::db::get_setting(&conn, "assistant.systemPrompt")
                    .ok()
                    .flatten()
            })
            .unwrap_or_default()
    };
```

Also extend the provider/model resolution just above (mod.rs:2270-2275): when the session's bot has a non-empty `provider`/`model`, use those over the passed arguments (one lookup via `db::bots::persona_for_session`'s sibling — add `pub fn model_for_session(conn, chat_session_id) -> DbResult<Option<(String, String)>>` in db/bots.rs returning the bot's non-empty provider/model pair).

- [ ] **Step 3: Verify the contract**

Run: `cd src-tauri && cargo test && cargo check`
Expected: PASS — the Task 1 `persona_for_session` tests are the unit-level contract; both call sites are one-line resolutions of it.

Manual smoke: create a bot whose prompt is `Always answer in exactly three words.`, open its thread in the Bots view, send a message, confirm the reply obeys the persona; a brand-new plain chat must behave exactly as before.

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

- In the retrieval path that builds the per-turn memory profile passed to `build_system_prompt` (`memory_profile` param, prompts.rs:823), resolve the session's bot the same way and pass `bot:<id>` — bot threads recall only their own memories.
- In the `memory_save` / `memory_recall` / `memory_forget` tool handlers, resolve the profile from the session id the tool runs in (same `bot_memory_profile` call). The bot saving a memory lands it in its own namespace; the user's `default` namespace is never touched from a bot thread.

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
}

export const listBots = () => safeInvoke<Bot[]>("list_bots");
export const createBot = (input: BotInput) => safeInvoke<Bot>("create_bot", { input });
export const updateBot = (botId: string, input: BotInput) =>
  safeInvoke<Bot>("update_bot", { botId, input });
export const deleteBot = (botId: string) => safeInvoke<void>("delete_bot", { botId });
export const setBotEnabled = (botId: string, enabled: boolean) =>
  safeInvoke<void>("set_bot_enabled", { botId, enabled });
export const ensureBotSession = (botId: string) =>
  safeInvoke<string>("ensure_bot_session", { botId });
```

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

**Files:**
- Create: `src/components/bots/BotEditorModal.tsx`
- Modify: `src/styles/bots.css` (modal styles)
- Test: `src/test/botEditorModal.test.tsx`

**Interfaces:**
- Consumes: `Bot`, `BotInput`, `createBot`/`updateBot` from `useBots` (Task 6).
- Produces: `BotEditorModal` props `{ bot?: Bot | null; onClose: () => void; onCreate: (input: BotInput) => Promise<Bot>; onUpdate?: (botId: string, input: BotInput) => Promise<Bot> }`. When `bot` is set it edits; otherwise it creates. Rail rows also get an edit (pencil) affordance opening this modal.

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
- Consumes: `db::bots::ensure_bot_session` (Task 1), persona injection (Task 4).
- Produces: `Automation.botId: String` (`""` = unowned, existing behavior); contract — a bot-bound run executes through `run_one_shot_chat` inside the bot's own session, so persona + memory apply with no extra plumbing.

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

    let sid = automations::prepare_bot_run(&conn, &automation).unwrap();
    let session = db::get_chat_session(&conn, &sid).unwrap().unwrap();
    assert_eq!(session.bot_id, Some(bot.id.clone()));
    // Idempotent: the run lands in the bot's ONE thread.
    let sid2 = automations::prepare_bot_run(&conn, &automation).unwrap();
    assert_eq!(sid, sid2);
}
```

- [ ] **Step 2: Run, watch it fail**

Run: `cd src-tauri && cargo test prepare_bot_run`
Expected: FAIL (function doesn't exist).

- [ ] **Step 3: Implement**

- db/automations.rs: add `pub bot_id: String,` to `Automation` (`#[serde(default)]` so old JSON payloads deserialize), `pub bot_id: Option<String>` to `AutomationInput`, map the column in the row mapper, set it in create/update (default `""`).
- automations.rs — new helper called from the run-prep region of `execute` (before the harness/chat branch):

```rust
/// Bot-bound runs execute inside the bot's own session (ensure_bot_session),
/// so run_one_shot_chat picks up the persona (chat/mod.rs) and memory scopes
/// to profile bot:<id> (memory/worker.rs). Returns the plain session path for
/// unowned automations untouched.
pub fn prepare_bot_run(
    conn: &rusqlite::Connection,
    automation: &Automation,
) -> Result<String, String> {
    if automation.bot_id.is_empty() {
        return Err("not a bot-bound automation".into());
    }
    db::bots::ensure_bot_session(conn, &automation.bot_id).map_err(|e| e.to_string())
}
```

- In `execute` (:725): when `!automation.bot_id.is_empty()`, take the chat branch — `prepare_bot_run`, then `crate::chat::run_one_shot_chat(db, &sid, &automation.prompt, &provider, &model, cancel)` (provider/model resolve from the bot via Task 4's `model_for_session`). CLI-harness spawning stays untouched for unowned automations. Also record the run session via the existing `set_automation_chat_session` so the run history keeps linking to the thread.

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
- `update_bot` / `delete_bot`: `bot_id` required; same emit-on-success.
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

**Files:**
- Create: `docs/architecture/BOTS.md`
- Modify: `docs/ai-context/AI_CONTEXT.md` (code-map entries: db/bots.rs, commands/bot_cmds.rs, chat/tools/bots.rs, components/bots/BotsView.tsx, BotEditorModal.tsx, BotsScreen)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write `docs/architecture/BOTS.md`**

Status header per the architecture-folder convention ("Status headers state what shipped"). Sections: identity model (dot + emoji + description; persona replaces the global prompt in the bot's thread, empty-persona fallback rule), thread model (one lazy session per bot via `ensure_bot_session`; the Bots view mounts the real ChatView on it; threads appear in Chat History like any session), memory scoping (`bot:<id>` profile namespace, `Bot.memory_enabled` gate), jobs (bot-bound automations run inside the bot's thread; run-while-closed via the existing schtasks path), main-chat tools (read/write classification, agent-created bots land disabled pending approval), surfaces (Bots view, BotEditorModal, mobile), and the explicit non-goals (no per-bot sandboxed computer, no connector directory, no settings-page editor, no bot-created bots).

- [ ] **Step 2: AI_CONTEXT + CHANGELOG**

Add the new files to the AI_CONTEXT.md code map with one-line descriptions; CHANGELOG entry under Unreleased → Added.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/BOTS.md docs/ai-context/AI_CONTEXT.md CHANGELOG.md
git commit -m "docs(bots): architecture doc + code map + changelog"
```

---

## Follow-ups (deliberately NOT in this plan)

- **Composer chip ("bind any chat to a bot persona")**: letting a *regular* chat borrow a bot's persona. Deferred — v1 keeps bot personas scoped to the bot's own thread; revisit if users ask for persona overlays.
- **Webhook → bot channel**: deliver an external POST as a user message in the bot's thread and trigger a turn.
- **Custom sprites** (image avatars) beyond emoji in the rail/modal.
- **`ask_bot` delegate tool**: main-chat agent hands a question to a bot via Session Mesh and returns its answer.
- **Per-bot tool allowlists** narrower than the global cap-state tool set.
- **Mobile bot creation** once the modal form is worth porting.

## Self-Review

- Spec coverage vs. the user's 2026-10-04 design: header entry + dedicated view (Task 7), left rail with name/emoji/description (Tasks 1, 7), center = the chat view for bots (Task 7 — the real ChatView on the bot's session), empty-state create promo + popup editor shared away from Settings (Tasks 7, 8), main-chat management tools read/write/run (Task 10) — all present; persona/memory/jobs carry over unchanged (Tasks 4, 5, 9).
- Placeholder scan: no TBDs; the two "mirror the neighboring code" instructions (migration error-matching, relay reply helper) name the exact file:line to copy; the ChatView mock note in the view test explains the jsdom stub.
- Type consistency: `Bot`/`BotInput` camelCase end-to-end (Rust serde ↔ TS, now including `description`); `ensure_bot_session` / `persona_for_session` / `bot_memory_profile` / `prepare_bot_run` names match across Tasks 1, 3, 4, 5, 7, 9; event name `bots:changed` matches in Tasks 2, 6, 7, 10; tool names `list_bots`/`create_bot`/`update_bot`/`delete_bot`/`run_bot` match the automations-tool naming family.
