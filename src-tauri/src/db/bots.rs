// Bots — named persistent agents (docs/architecture/BOTS.md). A bot is an
// identity: persona prompt + model + memory profile + standing jobs, with
// exactly one conversation of its own (ensure_bot_session). CRUD mirrors
// db/automations.rs (plain rusqlite, camelCase serde on the wire).
//
// Revision 2 semantics live here:
//   * update_bot is a PATCH — only fields that are `Some` change, so a rename
//     can never blank the persona or silently re-enable a disabled bot;
//   * names are trimmed, whitespace-collapsed, 1..=40 chars and unique
//     case-insensitively (unique index as the race backstop);
//   * thread vs run — `bot_role` is 'thread' (the bot's conversation) or 'run'
//     (one standing-job execution); `ensure_bot_session` only ever returns the
//     thread, and deleting a bot deletes its runs but keeps the thread as a
//     plain chat;
//   * the only "no bot" sentinel is NULL.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{new_id, now_ts, DbResult};

/// The pet a bot wears (the docked 3D companion on the composer / search-bar
/// strips — src/lib/pets). Empty string = no pet (the rail shows the emoji).
pub const BOT_PETS: [&str; 6] = ["cat", "fox", "panda", "dragon", "axolotl", "robot"];

pub const BOT_NAME_MAX: usize = 40;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub description: String,
    pub emoji: String,
    pub color: String,
    /// One of `BOT_PETS`, or "" for no pet.
    pub pet: String,
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
    pub pet: Option<String>,
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
    pub pet: Option<String>,
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
            pet: i.pet,
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

fn invalid(msg: &str) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(msg.to_string())
}

/// Trim, collapse inner whitespace, require 1..=BOT_NAME_MAX characters. The
/// messages are user-facing: the editor and the rail's inline rename show them
/// as-is.
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

/// A pet is either "" (none) or one of `BOT_PETS`. Anything else is a bug in
/// the caller, not a user error worth its own copy.
pub fn validate_bot_pet(raw: &str) -> DbResult<String> {
    let pet = raw.trim().to_ascii_lowercase();
    if pet.is_empty() || BOT_PETS.contains(&pet.as_str()) {
        return Ok(pet);
    }
    Err(invalid(&format!("Unknown pet: {raw}")))
}

/// Case-insensitive uniqueness, excluding the bot being renamed (so changing
/// only the case of its own name is allowed). Agents address bots by id, but
/// they find the id by name via `list_bots`, and approval summaries name the
/// bot — duplicates would make both ambiguous.
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

const COLS: &str = "id, name, description, emoji, color, pet, system_prompt, provider, model, \
     tools_enabled, memory_enabled, enabled, inherit_global_prompt, memory_read_default, \
     created_at, updated_at";

fn row_to_bot(row: &rusqlite::Row<'_>) -> rusqlite::Result<Bot> {
    Ok(Bot {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        emoji: row.get("emoji")?,
        color: row.get("color")?,
        pet: row.get("pet")?,
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
    let pet = validate_bot_pet(input.pet.as_deref().unwrap_or(""))?;
    let id = new_id();
    let now = now_ts();
    conn.execute(
        &format!(
            "INSERT INTO bots ({COLS})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
        ),
        params![
            id,
            name,
            input.description.as_deref().unwrap_or(""),
            input.emoji.as_deref().unwrap_or("🤖"),
            input.color.as_deref().unwrap_or(""),
            pet,
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

/// PATCH semantics (Revision 2). The original applied `unwrap_or(default)` to
/// every field, so a rename-only call blanked the persona and description and
/// silently set enabled = true — which would let an agent re-enable a bot and
/// bypass "agent-created bots land disabled". Now only `Some` fields change.
pub fn update_bot(conn: &Connection, bot_id: &str, patch: &BotPatch) -> DbResult<Bot> {
    let cur = get_bot(conn, bot_id)?
        .ok_or_else(|| invalid(&format!("bot not found: {bot_id}")))?;
    let name = match patch.name.as_deref() {
        Some(raw) => validate_bot_name(raw)?,
        None => cur.name.clone(),
    };
    if name != cur.name {
        // Excludes this bot, so a case-only change passes.
        ensure_name_free(conn, &name, Some(bot_id))?;
    }
    let emoji = patch.emoji.clone().unwrap_or_else(|| cur.emoji.clone());
    let pet = match patch.pet.as_deref() {
        Some(raw) => validate_bot_pet(raw)?,
        None => cur.pet.clone(),
    };
    conn.execute(
        "UPDATE bots SET name = ?2, description = ?3, emoji = ?4, color = ?5, pet = ?6,
                         system_prompt = ?7, provider = ?8, model = ?9,
                         tools_enabled = ?10, memory_enabled = ?11, enabled = ?12,
                         inherit_global_prompt = ?13, memory_read_default = ?14,
                         updated_at = ?15
         WHERE id = ?1",
        params![
            bot_id,
            name,
            patch.description.as_ref().unwrap_or(&cur.description),
            emoji,
            patch.color.as_ref().unwrap_or(&cur.color),
            pet,
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
        sync_thread_title(conn, bot_id, &name)?;
    }
    Ok(get_bot(conn, bot_id)?.expect("bot exists"))
}

/// The thread's title is the bot's plain NAME — the emoji is deliberately not
/// prefixed (it read as a stray 🔨/🛠️ in the session row). Keep it in step with
/// renames. Run sessions keep their own titles (they are history).
fn sync_thread_title(conn: &Connection, bot_id: &str, name: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET title = ?2 WHERE bot_id = ?1 AND bot_role = 'thread'",
        params![bot_id, name],
    )?;
    Ok(())
}

/// Result of deleting a bot, so the UI can say exactly what happened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBotOutcome {
    pub jobs_deleted: usize,
    pub runs_deleted: usize,
    /// Rows in profile `bot:<id>`; purged iff `purge_memory`.
    pub memories: usize,
}

/// Deleting a bot is ONE transaction and leaves nothing live behind
/// (Revision 2):
/// 1. its standing jobs are deleted — a job without its persona is
///    meaningless, and a dangling job must never fire;
/// 2. its run sessions (bot_role = 'run') are deleted outright — they are
///    internal activity, and unbinding them would leak dozens of
///    "⚙ job · timestamp" rows into Chat History;
/// 3. its thread session is unbound EXPLICITLY (no reliance on
///    PRAGMA foreign_keys) and stays in Chat History as a plain chat;
/// 4. each unbound thread's memory cursor jumps to its latest message, so old
///    bot turns are never re-extracted into the user's `default` profile;
/// 5. `bot:<id>` memories are purged only when `purge_memory` is set (the
///    command layer exports them to a Vault note first when asked);
/// 6. pending/resolved approvals are deleted with it.
pub fn delete_bot(conn: &Connection, bot_id: &str, purge_memory: bool) -> DbResult<DeleteBotOutcome> {
    let tx = conn.unchecked_transaction()?;
    let jobs_deleted = tx.execute("DELETE FROM automations WHERE bot_id = ?1", params![bot_id])?;
    let run_sessions: Vec<String> = {
        let mut stmt =
            tx.prepare("SELECT id FROM chat_sessions WHERE bot_id = ?1 AND bot_role = 'run'")?;
        let rows = stmt.query_map(params![bot_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let runs_deleted = run_sessions.len();
    for sid in &run_sessions {
        // automations.chat_session_id may point at the run log; clear first so
        // the delete can't trip a foreign-key constraint.
        tx.execute(
            "UPDATE automations SET chat_session_id = NULL WHERE chat_session_id = ?1",
            params![sid],
        )?;
        tx.execute("DELETE FROM chat_sessions WHERE id = ?1", params![sid])?;
    }
    let thread_sessions: Vec<String> = {
        let mut stmt =
            tx.prepare("SELECT id FROM chat_sessions WHERE bot_id = ?1 AND bot_role = 'thread'")?;
        let rows = stmt.query_map(params![bot_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<_, _>>()?
    };
    tx.execute(
        "UPDATE chat_sessions SET bot_id = NULL, bot_role = NULL, bot_job_id = NULL WHERE bot_id = ?1",
        params![bot_id],
    )?;
    for sid in &thread_sessions {
        freeze_memory_cursor(&tx, sid)?;
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
    let _ = tx.execute("DELETE FROM bot_approvals WHERE bot_id = ?1", params![bot_id]);
    tx.execute("DELETE FROM bots WHERE id = ?1", params![bot_id])?;
    tx.commit()?;
    Ok(DeleteBotOutcome {
        jobs_deleted,
        runs_deleted,
        memories,
    })
}

/// Advance a session's extraction cursor to its newest message so the memory
/// worker never re-reads a transcript that just lost its owner (which would
/// land a deleted bot's turns in the user's `default` profile).
fn freeze_memory_cursor(conn: &Connection, chat_session_id: &str) -> DbResult<()> {
    let latest: Option<i64> = conn
        .query_row(
            "SELECT MAX(id) FROM chat_messages WHERE chat_session_id = ?1",
            params![chat_session_id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten();
    if let Some(id) = latest {
        super::upsert_cursor(conn, chat_session_id, id)?;
    }
    Ok(())
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
    // Newest thread wins. `created_at` is second-granular, so a burst (opening
    // a bot and immediately starting a new conversation) ties — rowid breaks it
    // in insertion order, so the MOST RECENT conversation is returned.
    let mut stmt = conn.prepare(
        "SELECT s.id FROM chat_sessions s
         WHERE s.bot_id = ?1 AND s.bot_role = 'thread'
         ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1",
    )?;
    if let Some(sid) = stmt
        .query_row(params![bot_id], |r| r.get::<_, String>(0))
        .optional()?
    {
        return Ok(sid);
    }
    let bot = get_bot(conn, bot_id)?
        .ok_or_else(|| invalid(&format!("bot not found: {bot_id}")))?;
    // Plain name — see sync_thread_title on why the emoji is not prefixed.
    let title = bot.name.clone();
    new_bot_session(conn, &bot, "thread", None, &title)
}

/// Create a NEW conversation (`bot_role='thread'`) for a bot and return its
/// session id. A bot may hold several conversations; `ensure_bot_session`
/// returns the newest thread, so the freshly created one becomes the bot's
/// default while older ones stay listed in the Sessions rail.
pub fn create_bot_thread_session(conn: &Connection, bot_id: &str) -> DbResult<String> {
    let bot = get_bot(conn, bot_id)?
        .ok_or_else(|| invalid(&format!("bot not found: {bot_id}")))?;
    // Plain name — see sync_thread_title on why the emoji is not prefixed.
    let title = bot.name.clone();
    new_bot_session(conn, &bot, "thread", None, &title)
}

/// A fresh session for one standing-job run (or a delegated `ask_bot` call).
/// Same persona and memory profile as the thread (both key off bot_id);
/// separate history, hidden from Chat History.
pub fn create_bot_run_session(
    conn: &Connection,
    bot_id: &str,
    job_id: Option<&str>,
    job_name: &str,
) -> DbResult<String> {
    let bot = get_bot(conn, bot_id)?
        .ok_or_else(|| invalid(&format!("bot not found: {bot_id}")))?;
    // Plain job name — the bot's emoji is deliberately NOT prefixed onto the
    // title (it read as a stray 🔨/🛠️ "hammer" in the run's session row).
    let title = job_name.to_string();
    new_bot_session(conn, &bot, "run", job_id, &title)
}

fn new_bot_session(
    conn: &Connection,
    bot: &Bot,
    role: &str,
    job_id: Option<&str>,
    title: &str,
) -> DbResult<String> {
    let (provider, model, agent) = seed_provider_model(conn, bot)?;
    let session = super::create_chat_session(conn, &provider, &model, None)?;
    super::update_chat_session_title(conn, &session.id, title)?;
    if let Some(agent) = agent {
        super::update_chat_session_agent(conn, &session.id, Some(&agent))?;
    }
    super::chat::set_chat_session_bot(conn, &session.id, Some(&bot.id))?;
    super::chat::set_chat_session_bot_role(conn, &session.id, Some(role), job_id)?;
    Ok(session.id)
}

/// The bot's own provider/model if set; otherwise an auto-routed session —
/// exactly what a brand-new chat starts as (`provider = "auto"` ⟺
/// `auto_model = 1`), so the first send resolves a real pick instead of
/// inheriting whatever provider this plan's author assumed. NEVER hard-code a
/// provider here.
fn seed_provider_model(conn: &Connection, bot: &Bot) -> DbResult<(String, String, Option<String>)> {
    let _ = conn;
    if !bot.provider.is_empty() {
        // The bot pinned an engine; its sessions start there. "builtin" =
        // direct cloud API chat (the local/CLI values live in `provider`).
        let agent = match bot.provider.as_str() {
            "local_gguf" => "local",
            _ => "builtin",
        };
        return Ok((bot.provider.clone(), bot.model.clone(), Some(agent.into())));
    }
    Ok(("auto".into(), "auto".into(), Some("builtin".into())))
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

/// The bot's pinned provider/model for a session, when it has one. The send
/// paths prefer this over the session row (a standing job must keep running on
/// the bot's engine even after the user re-pointed their own chat).
pub fn model_for_session(
    conn: &Connection,
    chat_session_id: &str,
) -> DbResult<Option<(String, String)>> {
    let Some(bot) = get_bot_for_session(conn, chat_session_id)? else {
        return Ok(None);
    };
    if bot.provider.is_empty() {
        return Ok(None);
    }
    Ok(Some((bot.provider.clone(), bot.model.clone())))
}

/// The `custom` argument for `build_system_prompt` (Revision 2: persona LAYERS
/// on the user's global prompt instead of replacing it). Non-bot sessions get
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

/// A compact self-identity layered under the persona for EVERY bot turn. Without
/// it a bot with no custom persona is indistinguishable from the plain
/// assistant — it has no idea it is a named, scheduled, memory-owning bot
/// (Revision 3).
fn bot_identity(bot: &Bot) -> String {
    let mut out = format!(
        "You are \"{}\", a named bot on the user's machine — not the general assistant. \
         You keep your own conversation and your own memory.",
        bot.name
    );
    let desc = bot.description.trim();
    if !desc.is_empty() {
        out.push_str(&format!(" Your purpose: {desc}."));
    }
    out.push_str(
        " You can be scheduled to run standing jobs on your own; in a background run, \
         write-class actions are queued for the owner's approval and must not be retried. \
         Stay in character as this bot.",
    );
    out
}

/// Pure composition rule (unit-tested): the user's global prompt (unless the bot
/// opted out) + a bot identity line + the persona. Every bot therefore knows it
/// is a bot even with an empty persona; a non-bot session never reaches here.
pub fn compose_prompt(bot: &Bot, global: Option<&str>) -> Option<String> {
    let persona = bot.system_prompt.trim();
    let global = global.map(str::trim).filter(|g| !g.is_empty());
    let identity = bot_identity(bot);
    let bot_layer = if persona.is_empty() {
        identity
    } else {
        format!("{identity}\n\nPersona:\n{persona}")
    };
    Some(match (bot.inherit_global_prompt, global) {
        (true, Some(g)) => format!("{g}\n\n---\n{bot_layer}"),
        _ => bot_layer,
    })
}

fn get_bot_for_session(conn: &Connection, chat_session_id: &str) -> DbResult<Option<Bot>> {
    let mut stmt = conn.prepare(
        "SELECT b.* FROM bots b
         JOIN chat_sessions s ON s.bot_id = b.id
         WHERE s.id = ?1",
    )?;
    Ok(stmt
        .query_row(params![chat_session_id], row_to_bot)
        .optional()?)
}

/// Memory namespace for a bot: the existing `memories.profile` column holds
/// `bot:<id>`, so the whole memory pipeline scopes per bot with no schema
/// change. User memory stays on `default`.
pub fn bot_memory_profile(bot_id: &str) -> String {
    format!("bot:{bot_id}")
}

/// The profiles a session's recall may READ: always its own (`bot:<id>` or
/// `default`), plus the user's `default` when the bot opted into read-through.
/// Writes never use this list — see `memory_save` / extraction, which use the
/// session's own profile only.
pub fn read_profiles_for_session(conn: &Connection, chat_session_id: &str) -> DbResult<Vec<String>> {
    let Some(bot) = get_bot_for_session(conn, chat_session_id)? else {
        return Ok(vec!["default".to_string()]);
    };
    let own = bot_memory_profile(&bot.id);
    if bot.memory_read_default {
        Ok(vec![own, "default".to_string()])
    } else {
        Ok(vec![own])
    }
}

/// The memory profile a session's WRITES land in (extraction, memory_save,
/// memory_forget). Non-bot sessions keep `default`.
pub fn write_profile_for_session(conn: &Connection, chat_session_id: &str) -> DbResult<String> {
    let Some(bot) = get_bot_for_session(conn, chat_session_id)? else {
        return Ok("default".to_string());
    };
    Ok(bot_memory_profile(&bot.id))
}

/// May this session's turns use tools at all? True for every non-bot session
/// (unchanged behavior) and for bots with `tools_enabled` (Revision 2: the
/// toggle used to be decorative). False means the turn is assembled with an
/// empty tool set — the bot is chat-only.
pub fn tools_allowed(conn: &Connection, chat_session_id: &str) -> DbResult<bool> {
    match get_bot_for_session(conn, chat_session_id)? {
        Some(bot) => Ok(bot.tools_enabled),
        None => Ok(true),
    }
}

/// Should this session's memory be extracted at all? Bots with
/// `memory_enabled = false` opt out (the cursor still advances upstream, so
/// nothing is re-scanned later).
pub fn memory_enabled_for_session(conn: &Connection, chat_session_id: &str) -> DbResult<bool> {
    match get_bot_for_session(conn, chat_session_id)? {
        Some(bot) => Ok(bot.memory_enabled),
        None => Ok(true),
    }
}

// ---- headless runs (activity strip) ----

/// How many run sessions (and their bot_runs rows) are kept per bot before the
/// oldest are pruned. A constant for now: make it a setting only if someone
/// asks (docs/architecture/BOTS.md).
pub const BOT_RUN_KEEP: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotRun {
    pub id: String,
    pub bot_id: String,
    pub session_id: String,
    pub job_id: Option<String>,
    pub job_name: String,
    /// manual (run_bot_now from the view) | job (a standing job) | ask (ask_bot).
    pub source: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    /// running | ok | error | stopped. Pending approvals are reported
    /// separately (`pending_approvals`) so a finished run that queued a write
    /// still reads as finished — with a gold dot.
    pub status: String,
    pub summary: String,
    pub pending_approvals: i64,
}

fn map_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<BotRun> {
    Ok(BotRun {
        id: row.get("id")?,
        bot_id: row.get("bot_id")?,
        session_id: row.get("session_id")?,
        job_id: row.get("job_id")?,
        job_name: row.get("job_name")?,
        source: row.get("source")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        status: row.get("status")?,
        summary: row.get("summary")?,
        pending_approvals: row.get("pending_approvals").unwrap_or(0),
    })
}

/// Open a run: a fresh `bot_role = 'run'` session (persona + memory apply to
/// it automatically, because both key off `bot_id`) plus the activity row the
/// strip and the pruner read. Returns `(run_id, session_id)`.
pub fn start_bot_run(
    conn: &Connection,
    bot_id: &str,
    job_id: Option<&str>,
    job_name: &str,
    source: &str,
) -> DbResult<(String, String)> {
    let session_id = create_bot_run_session(conn, bot_id, job_id, job_name)?;
    let id = new_id();
    conn.execute(
        "INSERT INTO bot_runs (id, bot_id, session_id, job_id, job_name, source, started_at, status, summary)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', '')",
        params![id, bot_id, session_id, job_id, job_name, source, now_ts()],
    )?;
    Ok((id, session_id))
}

/// Close a run. Called for success, failure and cancel — a run row must never
/// be left `running` (the strip would show a forever-spinning dot).
pub fn finish_bot_run(conn: &Connection, run_id: &str, status: &str, summary: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE bot_runs SET status = ?2, summary = ?3, finished_at = ?4 WHERE id = ?1",
        params![run_id, status, summary, now_ts()],
    )?;
    Ok(())
}

/// A bot's recent runs, newest first, with each run's pending-approval count.
///
/// Only runs whose transcript still exists are returned: a row whose
/// `session_id` points at a deleted session renders in the activity strip but
/// does nothing on click (the session is gone), and picking it as a bot's
/// "live run" silently blocks opening the bot. Orphans shouldn't have survived
/// `delete_chat_session` (which now clears them) — this is the belt for rows
/// written before that, and `delete_orphan_bot_runs` removes them for good.
pub fn list_bot_runs(conn: &Connection, bot_id: &str, limit: usize) -> DbResult<Vec<BotRun>> {
    let mut stmt = conn.prepare(
        "SELECT r.*, (SELECT COUNT(*) FROM bot_approvals a
                       WHERE a.run_session_id = r.session_id AND a.status = 'pending') AS pending_approvals
         FROM bot_runs r
         WHERE r.bot_id = ?1
           AND EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id = r.session_id)
         ORDER BY r.started_at DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![bot_id, limit as i64], map_run)?;
    rows.collect()
}

/// Recent runs across every bot (the view's "everything that happened" read).
pub fn list_recent_bot_runs(conn: &Connection, limit: usize) -> DbResult<Vec<BotRun>> {
    let mut stmt = conn.prepare(
        "SELECT r.*, (SELECT COUNT(*) FROM bot_approvals a
                       WHERE a.run_session_id = r.session_id AND a.status = 'pending') AS pending_approvals
         FROM bot_runs r
         WHERE EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id = r.session_id)
         ORDER BY r.started_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64], map_run)?;
    rows.collect()
}

/// Delete run rows whose run session is gone (with their approvals). Run at
/// boot so a session deleted by an older build — before `delete_chat_session`
/// learned to clean these up — never shows as a dead row in the strip.
pub fn delete_orphan_bot_runs(conn: &Connection) -> usize {
    let n = conn
        .execute(
            "DELETE FROM bot_approvals WHERE run_session_id IN (
                 SELECT session_id FROM bot_runs r
                 WHERE NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id = r.session_id))",
            [],
        )
        .unwrap_or(0);
    let _ = n;
    conn.execute(
        "DELETE FROM bot_runs WHERE NOT EXISTS (
             SELECT 1 FROM chat_sessions s WHERE s.id = bot_runs.session_id)",
        [],
    )
    .unwrap_or(0)
}

// ---- cost attribution (the Usage page's Bots section) ----

/// Per-bot spend over a time window. A bot's cost is the sum over EVERY session
/// bound to it (`chat_sessions.bot_id`) — its conversations and all of its
/// runs — so "what am I spending on bots" is answerable in one read.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BotCost {
    pub bot_id: String,
    pub name: String,
    pub emoji: String,
    pub enabled: bool,
    /// Runs started in the window (bot_runs rows).
    pub runs: i64,
    /// Standing jobs currently bound to the bot (automations).
    pub jobs: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    /// Recorded `cost_usd`, falling back to the pricing estimate, summed.
    pub cost_usd: f64,
}

/// Every bot's spend since `since_secs` ago, dearest first. Small row counts
/// (one query per bot), matching `db::improve::artifact_cost_rollups`.
pub fn bot_cost_rollups(conn: &Connection, since_secs: i64) -> DbResult<Vec<BotCost>> {
    let cutoff = now_ts() - since_secs;
    let bots: Vec<(String, String, String, bool)> = {
        let mut stmt =
            conn.prepare("SELECT id, name, emoji, enabled FROM bots ORDER BY created_at ASC")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0))
        })?;
        rows.collect::<Result<_, _>>()?
    };

    let mut out = Vec::with_capacity(bots.len());
    for (bot_id, name, emoji, enabled) in bots {
        let (input_tokens, output_tokens, cache_read_tokens, cost_usd): (i64, i64, i64, f64) =
            conn.query_row(
                "SELECT COALESCE(SUM(m.input_tokens), 0),
                        COALESCE(SUM(m.output_tokens), 0),
                        COALESCE(SUM(m.cache_read_input_tokens), 0),
                        COALESCE(SUM(COALESCE(m.cost_usd, m.pricing_estimated_usd, 0)), 0.0)
                   FROM chat_messages m
                   JOIN chat_sessions s ON s.id = m.chat_session_id
                  WHERE s.bot_id = ?1 AND m.created_at >= ?2",
                params![bot_id, cutoff],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?;
        let runs: i64 = conn.query_row(
            "SELECT COUNT(*) FROM bot_runs WHERE bot_id = ?1 AND started_at >= ?2",
            params![bot_id, cutoff],
            |r| r.get(0),
        )?;
        let jobs: i64 = conn.query_row(
            "SELECT COUNT(*) FROM automations WHERE bot_id = ?1",
            params![bot_id],
            |r| r.get(0),
        )?;
        out.push(BotCost {
            bot_id,
            name,
            emoji,
            enabled,
            runs,
            jobs,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cost_usd,
        });
    }
    out.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

/// How long a bot run may legitimately stay `running` before a boot sweep
/// settles it: runs last up to `automations::MAX_RUN_SECS` (2h), and the
/// in-memory running registry is per-process, so at boot any older `running`
/// row is a crash leftover (the same reasoning as `sweep_stale_subagent_runs`).
pub const BOT_STALE_RUNNING_SECS: i64 = 2 * 60 * 60;

/// Settle `running` rows older than `max_age_secs` as `interrupted`. Without
/// this an app close mid-run left the row (and the rail) `running` forever —
/// a phantom in-flight run nobody can open or finish. Age-gated so a
/// concurrently running second instance is never disturbed.
pub fn sweep_stale_bot_runs(conn: &Connection, max_age_secs: i64) -> usize {
    let now = now_ts();
    let cutoff = now - max_age_secs;
    conn.execute(
        "UPDATE bot_runs SET finished_at = ?1, status = 'interrupted', \
         summary = CASE WHEN summary = '' THEN 'interrupted — the app exited mid-run' ELSE summary END \
         WHERE status = 'running' AND started_at <= ?2",
        params![now, cutoff],
    )
    .unwrap_or(0)
}

/// Delete the oldest run sessions beyond `keep` (messages, approvals and the
/// activity rows go with them). Without this a bot with a 5-minute cron would
/// accumulate thousands of sessions.
pub fn prune_runs(conn: &Connection, bot_id: &str, keep: usize) -> DbResult<usize> {
    let tx = conn.unchecked_transaction()?;
    let doomed: Vec<(String, String)> = {
        // started_at is second-granular: a burst of runs ties on it, and an
        // unstable order would prune an ARBITRARY subset (including the wrong
        // one). rowid breaks the tie in insertion order, so the newest N rows
        // are exactly the ones created last.
        let mut stmt = tx.prepare(
            "SELECT id, session_id FROM bot_runs WHERE bot_id = ?1
             ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?2",
        )?;
        let rows = stmt.query_map(params![bot_id, keep as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    for (run_id, session_id) in &doomed {
        tx.execute("DELETE FROM bot_approvals WHERE run_session_id = ?1", params![session_id])?;
        tx.execute("UPDATE automations SET chat_session_id = NULL WHERE chat_session_id = ?1", params![session_id])?;
        tx.execute("DELETE FROM chat_sessions WHERE id = ?1", params![session_id])?;
        tx.execute("DELETE FROM bot_runs WHERE id = ?1", params![run_id])?;
    }
    tx.commit()?;
    Ok(doomed.len())
}

/// Post ONE compact summary of a finished run into the bot's thread, so the
/// conversation stays a conversation ("what did my bot do today?") while the
/// transcript itself lives in the run session. `text` is the run's final
/// assistant message, clearly marked as an excerpt — never a model-written
/// summary of a different model's work.
pub fn post_run_summary(
    conn: &Connection,
    bot_id: &str,
    job_name: &str,
    status: &str,
    text: &str,
) -> DbResult<Option<String>> {
    let Some(bot) = get_bot(conn, bot_id)? else {
        return Ok(None);
    };
    let thread = ensure_bot_session(conn, bot_id)?;
    let excerpt: String = text.trim().chars().take(400).collect();
    let status_word = match status {
        "ok" => "finished",
        "error" => "failed",
        "stopped" => "stopped",
        other => other,
    };
    let body = if excerpt.is_empty() {
        "(no reply recorded)".to_string()
    } else {
        format!("{excerpt}{}", if text.trim().chars().count() > 400 { "…" } else { "" })
    };
    let content = format!(
        "⚙ **{}** {} · {} — excerpt from the run's transcript:

{}",
        bot.emoji,
        job_name,
        status_word,
        body
    );
    super::add_chat_message(
        conn,
        super::NewChatMessage {
            chat_session_id: &thread,
            role: "assistant",
            content: &content,
            ..Default::default()
        },
    )?;
    super::touch_chat_session(conn, &thread)?;
    Ok(Some(thread))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        super::super::mem()
    }

    fn input(name: &str) -> BotInput {
        BotInput {
            name: name.into(),
            description: Some("Morning briefing agent".into()),
            emoji: Some("🛰️".into()),
            color: Some("#4ec9b0".into()),
            pet: Some("fox".into()),
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
        assert_eq!(bot.pet, "fox");
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
        assert_eq!(sess.bot_role.as_deref(), Some("thread"));
        assert!(sess.title.as_deref().unwrap_or("").contains("Atlas"));
    }

    #[test]
    fn bot_costs_sum_session_spend_in_range() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let thread = ensure_bot_session(&c, &bot.id).unwrap();
        let (_run_id, run_sid) = start_bot_run(&c, &bot.id, None, "Manual run", "manual").unwrap();
        let now = now_ts();
        let insert = |sid: &str, cost: f64, tin: i64, tout: i64, at: i64| {
            c.execute(
                "INSERT INTO chat_messages
                   (chat_session_id, role, content, created_at, input_tokens, output_tokens, cost_usd, cache_read_input_tokens)
                 VALUES (?1, 'assistant', 'x', ?2, ?3, ?4, ?5, 10)",
                params![sid, at, tin, tout, cost],
            )
            .unwrap();
        };
        insert(&thread, 0.25, 100, 50, now);
        insert(&run_sid, 0.10, 200, 20, now);
        // An out-of-range message must be excluded.
        insert(&thread, 9.99, 1000, 1000, now - 40 * 86_400);

        let rows = bot_cost_rollups(&c, 30 * 86_400).unwrap();
        let r = rows.iter().find(|r| r.bot_id == bot.id).unwrap();
        assert_eq!(r.input_tokens, 300);
        assert_eq!(r.output_tokens, 70);
        assert_eq!(r.cache_read_tokens, 20);
        assert!((r.cost_usd - 0.35).abs() < 1e-9, "got {}", r.cost_usd);
        assert_eq!(r.runs, 1, "only the in-range run is counted");
        assert_eq!(r.jobs, 0);
    }

    #[test]
    fn new_conversation_creates_an_additional_thread() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let first = ensure_bot_session(&c, &bot.id).unwrap();
        let second = create_bot_thread_session(&c, &bot.id).unwrap();
        assert_ne!(first, second);
        // `ensure_bot_session` always returns the NEWEST thread.
        assert_eq!(ensure_bot_session(&c, &bot.id).unwrap(), second);
        let s = super::super::get_chat_session(&c, &second).unwrap().unwrap();
        assert_eq!(s.bot_role.as_deref(), Some("thread"));
        assert_eq!(s.bot_id.as_deref(), Some(bot.id.as_str()));
        // Both conversations survive; deleting the bot unbinds them (keeps them
        // as plain chats), so both remain readable.
        delete_bot(&c, &bot.id, false).unwrap();
        assert!(super::super::get_chat_session(&c, &first).unwrap().is_some());
        assert!(super::super::get_chat_session(&c, &second).unwrap().is_some());
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
    fn deleting_bot_unbinds_thread_sessions_without_deleting_them() {
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
        let both = resolve_custom_prompt(&c, &sid, Some("Reply in French.".into()))
            .unwrap()
            .unwrap();
        assert!(both.contains("Reply in French.") && both.contains("You are Atlas"));
        let opt_out = BotPatch {
            inherit_global_prompt: Some(false),
            ..Default::default()
        };
        update_bot(&c, &bot.id, &opt_out).unwrap();
        let only = resolve_custom_prompt(&c, &sid, Some("Reply in French.".into()))
            .unwrap()
            .unwrap();
        assert!(!only.contains("French") && only.contains("You are Atlas"));
        // A non-bot session gets the global prompt back untouched.
        let plain = super::super::create_chat_session(&c, "openai", "gpt-5", None).unwrap();
        assert_eq!(
            resolve_custom_prompt(&c, &plain.id, Some("Reply in French.".into()))
                .unwrap()
                .as_deref(),
            Some("Reply in French.")
        );
    }

    #[test]
    fn empty_persona_bot_still_gets_a_bot_identity() {
        let c = conn();
        let mut empty = input("Quiet");
        empty.system_prompt = Some("".into());
        let bot = create_bot(&c, &empty).unwrap();
        let sid = ensure_bot_session(&c, &bot.id).unwrap();
        let prompt = resolve_custom_prompt(&c, &sid, Some("Reply in French.".into()))
            .unwrap()
            .unwrap();
        // The global prompt still layers in, AND the bot now knows it is a bot.
        assert!(prompt.contains("Reply in French."));
        assert!(prompt.contains("\"Quiet\"") && prompt.contains("named bot"));
        // Opting out with no persona still yields the identity — never the raw
        // (persona-less) global prompt that used to make a bot a plain chat.
        let opt_out = BotPatch {
            inherit_global_prompt: Some(false),
            ..Default::default()
        };
        update_bot(&c, &bot.id, &opt_out).unwrap();
        let only = resolve_custom_prompt(&c, &sid, Some("Reply in French.".into()))
            .unwrap()
            .unwrap();
        assert!(!only.contains("French") && only.contains("\"Quiet\""));
    }

    #[test]
    fn deleting_bot_removes_its_standing_jobs_but_not_others() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let mine = super::super::automations::create_automation(
            &c,
            &super::super::AutomationInput {
                name: "Morning sweep".into(),
                prompt: "Sweep.".into(),
                harness: "chat".into(),
                model: None,
                cwd: None,
                schedule: "0 9 * * *".into(),
                enabled: Some(true),
                origin: Some("user".into()),
                trigger_type: Some("cron".into()),
                trigger_config: Some("{}".into()),
                chat_mode: None,
                bot_id: Some(bot.id.clone()),
            },
        )
        .unwrap();
        let _other = super::super::automations::create_automation(
            &c,
            &super::super::AutomationInput {
                name: "Unowned".into(),
                prompt: "Nothing.".into(),
                harness: "chat".into(),
                model: None,
                cwd: None,
                schedule: "0 9 * * *".into(),
                enabled: Some(true),
                origin: Some("user".into()),
                trigger_type: Some("cron".into()),
                trigger_config: Some("{}".into()),
                chat_mode: None,
                bot_id: None,
            },
        )
        .unwrap();
        let outcome = delete_bot(&c, &bot.id, false).unwrap();
        assert_eq!(outcome.jobs_deleted, 1);
        let left = super::super::automations::list_automations(&c).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].name, "Unowned");
        let _ = mine;
    }

    /// `MemoryRecord::new_extracted` stamps profile "default"; bot rows carry
    /// their own profile.
    fn memory(content: &str, profile: &str) -> crate::memory::model::MemoryRecord {
        let mut rec = crate::memory::model::MemoryRecord::new_extracted(
            &format!("mem-{}-{}", profile, content),
            "fact",
            None,
            "user",
            content,
            3,
            None,
        );
        rec.profile = profile.to_string();
        rec
    }

    #[test]
    fn deleting_bot_can_purge_its_memory_profile() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let profile = bot_memory_profile(&bot.id);
        for i in 0..2 {
            super::super::insert_memory(&c, &memory(&format!("fact {i}"), &profile)).unwrap();
        }
        super::super::insert_memory(&c, &memory("user fact", "default")).unwrap();
        let outcome = delete_bot(&c, &bot.id, true).unwrap();
        assert_eq!(outcome.memories, 2);
        assert_eq!(super::super::list_memories(&c, "default", false).unwrap().len(), 1);
        // purge_memory = false keeps the rows (the caller exported them).
        let bot2 = create_bot(&c, &input("Scout")).unwrap();
        let p2 = bot_memory_profile(&bot2.id);
        super::super::insert_memory(&c, &memory("another", &p2)).unwrap();
        let outcome = delete_bot(&c, &bot2.id, false).unwrap();
        assert_eq!(outcome.memories, 1);
        assert_eq!(super::super::list_memories(&c, &p2, false).unwrap().len(), 1);
    }

    #[test]
    fn thread_lookup_ignores_run_sessions() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let thread = ensure_bot_session(&c, &bot.id).unwrap();
        let run = create_bot_run_session(&c, &bot.id, Some("auto-1"), "Morning sweep").unwrap();
        assert_ne!(thread, run);
        // The newest session is the run — ensure_bot_session must still return
        // the thread.
        assert_eq!(ensure_bot_session(&c, &bot.id).unwrap(), thread);
        // Deleting the bot deletes the run but keeps the thread.
        let outcome = delete_bot(&c, &bot.id, false).unwrap();
        assert_eq!(outcome.runs_deleted, 1);
        assert!(super::super::get_chat_session(&c, &run).unwrap().is_none());
        assert!(super::super::get_chat_session(&c, &thread).unwrap().is_some());
    }

    #[test]
    fn new_bot_sessions_follow_the_bots_engine_and_never_hardcode_a_provider() {
        let c = conn();
        let pinned = create_bot(&c, &input("Atlas")).unwrap();
        let sid = ensure_bot_session(&c, &pinned.id).unwrap();
        let s = super::super::get_chat_session(&c, &sid).unwrap().unwrap();
        assert_eq!((s.provider.as_str(), s.model.as_str()), ("anthropic", "claude-sonnet-4-5"));
        assert_eq!(s.agent.as_deref(), Some("builtin"));

        // An "inherit" bot lands on an auto-routed session (resolved per send),
        // not on some hard-coded vendor.
        let mut inherit = input("Scout");
        inherit.provider = Some("".into());
        inherit.model = Some("".into());
        let b2 = create_bot(&c, &inherit).unwrap();
        let sid2 = ensure_bot_session(&c, &b2.id).unwrap();
        let s2 = super::super::get_chat_session(&c, &sid2).unwrap().unwrap();
        assert_eq!((s2.provider.as_str(), s2.model.as_str()), ("auto", "auto"));
        assert!(s2.auto_model);
    }

    #[test]
    fn rename_keeps_other_fields_and_syncs_thread_title() {
        let c = conn();
        let mut disabled = input("Atlas");
        disabled.enabled = Some(false);
        let bot = create_bot(&c, &disabled).unwrap();
        let sid = ensure_bot_session(&c, &bot.id).unwrap();
        let patch = BotPatch {
            name: Some("  Orion   Prime ".into()),
            ..Default::default()
        };
        let renamed = update_bot(&c, &bot.id, &patch).unwrap();
        assert_eq!(renamed.name, "Orion Prime"); // trimmed + collapsed
        assert!(!renamed.enabled); // a rename must NOT re-enable
        assert!(renamed.system_prompt.starts_with("You are Atlas")); // nor blank the persona
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
        assert!(create_bot(&c, &input("atlas")).is_err()); // duplicate, any case
        let taken = BotPatch {
            name: Some("ATLAS".into()),
            ..Default::default()
        };
        assert!(update_bot(&c, &b.id, &taken).is_err());
        // Changing only the case of its OWN name is allowed.
        assert_eq!(update_bot(&c, &a.id, &taken).unwrap().name, "ATLAS");
    }

    #[test]
    fn pets_are_validated_against_the_six_species() {
        let c = conn();
        let mut bad = input("Nope");
        bad.pet = Some("unicorn".into());
        assert!(create_bot(&c, &bad).is_err());
        let mut none = input("Plain");
        none.pet = Some("".into());
        assert_eq!(create_bot(&c, &none).unwrap().pet, "");
        let bot = create_bot(&c, &input("Dragon fan")).unwrap();
        let patch = BotPatch {
            pet: Some("Dragon".into()),
            ..Default::default()
        };
        assert_eq!(update_bot(&c, &bot.id, &patch).unwrap().pet, "dragon");
    }

    #[test]
    fn memory_profiles_respect_the_bot_and_its_read_through_flag() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let sid = ensure_bot_session(&c, &bot.id).unwrap();
        assert_eq!(write_profile_for_session(&c, &sid).unwrap(), bot_memory_profile(&bot.id));
        assert_eq!(read_profiles_for_session(&c, &sid).unwrap(), vec![bot_memory_profile(&bot.id)]);
        let patch = BotPatch {
            memory_read_default: Some(true),
            ..Default::default()
        };
        update_bot(&c, &bot.id, &patch).unwrap();
        assert_eq!(
            read_profiles_for_session(&c, &sid).unwrap(),
            vec![bot_memory_profile(&bot.id), "default".to_string()]
        );
        // Non-bot sessions are untouched.
        let plain = super::super::create_chat_session(&c, "openai", "gpt-5", None).unwrap();
        assert_eq!(write_profile_for_session(&c, &plain.id).unwrap(), "default");
        assert_eq!(read_profiles_for_session(&c, &plain.id).unwrap(), vec!["default".to_string()]);
    }

    #[test]
    fn tools_allowed_reflects_the_toggle_but_defaults_true() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let sid = ensure_bot_session(&c, &bot.id).unwrap();
        assert!(tools_allowed(&c, &sid).unwrap());
        let patch = BotPatch {
            tools_enabled: Some(false),
            ..Default::default()
        };
        update_bot(&c, &bot.id, &patch).unwrap();
        assert!(!tools_allowed(&c, &sid).unwrap());
        // The two toggles are independent: disabling tools leaves memory on.
        assert!(memory_enabled_for_session(&c, &sid).unwrap());
        let patch = BotPatch {
            memory_enabled: Some(false),
            ..Default::default()
        };
        update_bot(&c, &bot.id, &patch).unwrap();
        assert!(!memory_enabled_for_session(&c, &sid).unwrap());
        let plain = super::super::create_chat_session(&c, "openai", "gpt-5", None).unwrap();
        assert!(tools_allowed(&c, &plain.id).unwrap());
        assert!(memory_enabled_for_session(&c, &plain.id).unwrap());
    }

    #[test]
    fn deleting_a_bot_freezes_the_threads_memory_cursor() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let sid = ensure_bot_session(&c, &bot.id).unwrap();
        c.execute(
            "INSERT INTO chat_messages (chat_session_id, role, content, created_at)
             VALUES (?1, 'user', 'hello', ?2)",
            params![sid, now_ts()],
        )
        .unwrap();
        let latest: i64 = c
            .query_row(
                "SELECT MAX(id) FROM chat_messages WHERE chat_session_id = ?1",
                params![sid],
                |r| r.get(0),
            )
            .unwrap();
        delete_bot(&c, &bot.id, false).unwrap();
        let cursor = super::super::get_cursor(&c, &sid).unwrap();
        assert_eq!(
            cursor, latest,
            "cursor must advance so old turns are never re-extracted"
        );
    }

    #[test]
    fn runs_are_listed_pruned_and_summarized_in_the_thread() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let thread = ensure_bot_session(&c, &bot.id).unwrap();
        let (run_id, sid) = start_bot_run(&c, &bot.id, Some("auto-1"), "Morning sweep", "job").unwrap();
        let runs = list_bot_runs(&c, &bot.id, 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "running");
        assert_eq!(runs[0].job_name, "Morning sweep");
        assert_eq!(runs[0].source, "job");
        assert_eq!(runs[0].session_id, sid);

        finish_bot_run(&c, &run_id, "ok", "All clear.").unwrap();
        let runs = list_bot_runs(&c, &bot.id, 10).unwrap();
        assert_eq!(runs[0].status, "ok");
        assert!(runs[0].finished_at.is_some());

        // The summary lands in the THREAD (once), never in the run session.
        let posted = post_run_summary(&c, &bot.id, "Morning sweep", "ok", "All clear.").unwrap();
        assert_eq!(posted.as_deref(), Some(thread.as_str()));
        let msgs = super::super::list_active_chat_messages(&c, &thread).unwrap();
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].content.contains("Morning sweep") && msgs[0].content.contains("All clear."));

        // Pruning keeps the newest N and removes the run session with its row.
        for i in 0..4 {
            let (_, sid_n) = start_bot_run(&c, &bot.id, None, &format!("run {i}"), "manual").unwrap();
            let _ = sid_n;
        }
        let pruned = prune_runs(&c, &bot.id, 3).unwrap();
        assert_eq!(pruned, 2, "5 runs total, keep 3");
        let kept = list_bot_runs(&c, &bot.id, 10).unwrap();
        assert_eq!(kept.len(), 3);
        // Pruning removes the OLDEST runs (timestamps tie within a second, so
        // the tiebreak is insertion order): the first run's session is gone.
        assert!(!kept.iter().any(|r| r.session_id == sid));
        assert!(super::super::get_chat_session(&c, &sid).unwrap().is_none());
        // The thread is never a run session and survives pruning.
        assert!(super::super::get_chat_session(&c, &thread).unwrap().is_some());
    }

    #[test]
    fn run_rows_report_pending_approvals() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let (_run_id, sid) = start_bot_run(&c, &bot.id, None, "Manual run", "manual").unwrap();
        super::super::bot_approvals::insert_approval(
            &c,
            &bot.id,
            &sid,
            "create_vault_note",
            "{}",
            "Create vault note \"Standup\"",
        )
        .unwrap();
        let runs = list_bot_runs(&c, &bot.id, 5).unwrap();
        assert_eq!(runs[0].pending_approvals, 1);
    }

    #[test]
    fn deleting_a_run_session_cleans_up_its_bot_rows() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let (_run_id, sid) = start_bot_run(&c, &bot.id, None, "Manual run", "manual").unwrap();
        super::super::bot_approvals::insert_approval(
            &c,
            &bot.id,
            &sid,
            "run_shell",
            "{}",
            "Run shell: ls",
        )
        .unwrap();
        assert_eq!(list_bot_runs(&c, &bot.id, 5).unwrap().len(), 1);

        // The Bots rail lets the user delete a run session; the row and its
        // approvals must not outlive it (neither carries a foreign key).
        super::super::delete_chat_session(&c, &sid).unwrap();

        assert!(
            list_bot_runs(&c, &bot.id, 5).unwrap().is_empty(),
            "the run row must go with its session"
        );
        assert_eq!(
            super::super::bot_approvals::list_approvals(&c, Some(&bot.id))
                .unwrap()
                .len(),
            0,
            "a pending approval must not outlive its run session"
        );
    }

    #[test]
    fn stale_and_orphan_bot_runs_are_settled_and_hidden() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        // A live run (its session exists) stays visible.
        let (_live_run, live_sid) = start_bot_run(&c, &bot.id, None, "Live", "manual").unwrap();
        // A crash leftover: `running` and older than the sweep threshold.
        let (stale_run, _stale_sid) = start_bot_run(&c, &bot.id, None, "Stale", "manual").unwrap();
        c.execute(
            "UPDATE bot_runs SET started_at = ?2 WHERE id = ?1",
            params![stale_run, now_ts() - BOT_STALE_RUNNING_SECS - 60],
        )
        .unwrap();

        assert_eq!(sweep_stale_bot_runs(&c, BOT_STALE_RUNNING_SECS), 1);
        let runs = list_bot_runs(&c, &bot.id, 10).unwrap();
        let stale = runs.iter().find(|r| r.id == stale_run).unwrap();
        assert_eq!(stale.status, "interrupted");
        assert!(stale.finished_at.is_some());

        // An orphan (its run session is gone) is hidden by the list. Delete the
        // session row directly to simulate a leftover written by an older build
        // — `delete_chat_session` itself now clears the bot rows (tested above).
        c.execute("DELETE FROM chat_sessions WHERE id = ?1", params![live_sid])
            .unwrap();
        let visible = list_bot_runs(&c, &bot.id, 10).unwrap();
        assert!(
            visible.iter().all(|r| r.session_id != live_sid),
            "a run whose session is gone must not be listed"
        );
        // …and removed for good by the boot cleanup.
        assert!(delete_orphan_bot_runs(&c) >= 1);
        assert!(
            list_bot_runs(&c, &bot.id, 10)
                .unwrap()
                .iter()
                .all(|r| r.session_id != live_sid)
        );
    }

    #[test]
    fn empty_session_sweeper_leaves_bot_sessions_alone() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let thread = ensure_bot_session(&c, &bot.id).unwrap();
        let (_run_id, run_sid) = start_bot_run(&c, &bot.id, None, "Manual run", "manual").unwrap();
        // Both bot sessions are still empty (no messages): the sweeper must not
        // delete them, or the manually-started run would orphan its bot_runs row.
        super::super::delete_empty_chat_sessions(&c, None).unwrap();
        assert!(super::super::get_chat_session(&c, &thread).unwrap().is_some());
        assert!(super::super::get_chat_session(&c, &run_sid).unwrap().is_some());
        assert_eq!(list_bot_runs(&c, &bot.id, 5).unwrap().len(), 1);
    }

    #[test]
    fn model_for_session_returns_pinned_engine_only() {
        let c = conn();
        let bot = create_bot(&c, &input("Atlas")).unwrap();
        let sid = ensure_bot_session(&c, &bot.id).unwrap();
        assert_eq!(
            model_for_session(&c, &sid).unwrap(),
            Some(("anthropic".to_string(), "claude-sonnet-4-5".to_string()))
        );
        let mut inherit = input("Scout");
        inherit.provider = Some("".into());
        let b2 = create_bot(&c, &inherit).unwrap();
        let sid2 = ensure_bot_session(&c, &b2.id).unwrap();
        assert_eq!(model_for_session(&c, &sid2).unwrap(), None);
    }
}
