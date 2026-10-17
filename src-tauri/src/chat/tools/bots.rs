// Bots chat tools — the main-chat agent can inspect, create, edit, run and
// delegate to bots (docs/architecture/BOTS.md). Mirrors tools/automations.rs:
// read tools answer inline; write tools are write-classified (approval) and
// agent-created bots land DISABLED pending the owner's approval, exactly like
// agent-created automations.
//
// Two rules the handlers enforce so an agent can never route around the
// owner's consent:
//   * agent-origin updates DROP `enabled` — approving a bot is the owner's
//     action (the Bots view), not the model's;
//   * agent-facing `delete_bot` always keeps the bot's memories
//     (`purge_memory = false`); only the owner's editor can purge.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::*;
use crate::db;

fn emit_changed(app: &AppHandle, action: &str, bot_id: &str) {
    let _ = app.emit(
        "bots:changed",
        serde_json::json!({ "action": action, "botId": bot_id }),
    );
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

fn bool_arg(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|v| v.as_bool())
}

pub(crate) fn is_bot_tool(name: &str) -> bool {
    matches!(
        name,
        LIST_BOTS | CREATE_BOT | UPDATE_BOT | DELETE_BOT | RUN_BOT | ASK_BOT
    )
}

/// Mutating members of the family. The plan gate treats these like any other
/// state-changing tool; `ask_bot` is read-class on purpose (the delegation it
/// starts is itself gated — see `chat::bot_policy`).
pub(crate) fn is_mutating_bot_tool(name: &str) -> bool {
    matches!(name, CREATE_BOT | UPDATE_BOT | DELETE_BOT | RUN_BOT)
}

pub(crate) async fn execute_bot_tool(app: &AppHandle, name: &str, args: &Value) -> String {
    match name {
        LIST_BOTS => list(app, args),
        CREATE_BOT => create(app, args),
        UPDATE_BOT => update(app, args),
        DELETE_BOT => delete(app, args),
        RUN_BOT => run(app, args),
        ASK_BOT => ask(app, args).await,
        other => format!("Unknown tool: {other}"),
    }
}

fn list(app: &AppHandle, args: &Value) -> String {
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    let bots = match db::bots::list_bots(&conn) {
        Ok(b) => b,
        Err(e) => return format!("Could not list bots: {e}"),
    };
    if bots.is_empty() {
        return "No bots exist yet. Create one with create_bot (name, persona, pet) — it lands \
                disabled until the user approves it in the Bots view."
            .to_string();
    }
    let only = str_arg(args, "bot_id");
    let running = crate::bot_runs::running_bots();
    let mut out = String::new();
    for b in bots.iter().filter(|b| only.map(|id| id == b.id).unwrap_or(true)) {
        let jobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM automations WHERE bot_id = ?1",
                rusqlite::params![b.id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let pending = db::bot_approvals::count_pending_approvals(&conn, &b.id).unwrap_or(0);
        out.push_str(&format!(
            "- {} {} (id {}){} — {} · pet: {} · jobs: {} · pending approvals: {}{}\n",
            b.emoji,
            b.name,
            b.id,
            if b.enabled { "" } else { " [DISABLED — awaiting approval]" },
            if b.description.is_empty() { "(no description)" } else { b.description.as_str() },
            if b.pet.is_empty() { "none" } else { b.pet.as_str() },
            jobs,
            pending,
            if running.contains(&b.id) { " · WORKING NOW" } else { "" },
        ));
    }
    out
}

fn create(app: &AppHandle, args: &Value) -> String {
    let Some(name) = str_arg(args, "name") else {
        return "create_bot needs a `name` (1–40 characters, unique).".to_string();
    };
    let input = db::BotInput {
        name: name.to_string(),
        description: str_arg(args, "description").map(String::from),
        emoji: str_arg(args, "emoji").map(String::from),
        color: None,
        pet: str_arg(args, "pet").map(String::from),
        system_prompt: str_arg(args, "persona").map(String::from),
        provider: str_arg(args, "provider").map(String::from),
        model: str_arg(args, "model").map(String::from),
        tools_enabled: bool_arg(args, "tools_enabled"),
        memory_enabled: bool_arg(args, "memory_enabled"),
        // Agent-created bots land disabled — the owner approves them in the
        // Bots view (mirrors agent-created automations).
        enabled: Some(false),
        inherit_global_prompt: bool_arg(args, "inherit_global_prompt"),
        memory_read_default: bool_arg(args, "memory_read_default"),
    };
    let bot = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        match db::bots::create_bot(&conn, &input) {
            Ok(b) => b,
            Err(e) => return format!("Could not create the bot: {e}"),
        }
    };
    emit_changed(app, "created", &bot.id);
    format!(
        "Bot \"{}\" created (id {}) — DISABLED until the user approves it in the Bots view. \
         Its thread exists but its standing jobs and run_bot are refused until then.",
        bot.name, bot.id
    )
}

fn update(app: &AppHandle, args: &Value) -> String {
    let Some(bot_id) = str_arg(args, "bot_id") else {
        return "update_bot needs a `bot_id` (use list_bots to find it).".to_string();
    };
    let patch = db::BotPatch {
        name: str_arg(args, "name").map(String::from),
        description: str_arg(args, "description").map(String::from),
        emoji: str_arg(args, "emoji").map(String::from),
        color: None,
        pet: str_arg(args, "pet").map(String::from),
        system_prompt: str_arg(args, "persona").map(String::from),
        provider: str_arg(args, "provider").map(String::from),
        model: str_arg(args, "model").map(String::from),
        tools_enabled: bool_arg(args, "tools_enabled"),
        memory_enabled: bool_arg(args, "memory_enabled"),
        // Deliberately dropped: an agent-origin update cannot enable a bot.
        enabled: None,
        inherit_global_prompt: bool_arg(args, "inherit_global_prompt"),
        memory_read_default: bool_arg(args, "memory_read_default"),
    };
    let bot = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        match db::bots::update_bot(&conn, bot_id, &patch) {
            Ok(b) => b,
            Err(e) => return format!("Could not update the bot: {e}"),
        }
    };
    emit_changed(app, "updated", &bot.id);
    format!(
        "Updated \"{}\" ({}).{}",
        bot.name,
        bot.id,
        if bot.enabled {
            ""
        } else {
            " It is still disabled — enabling is the user's call in the Bots view."
        }
    )
}

fn delete(app: &AppHandle, args: &Value) -> String {
    let Some(bot_id) = str_arg(args, "bot_id") else {
        return "delete_bot needs a `bot_id`.".to_string();
    };
    let (name, outcome) = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let name = db::bots::get_bot(&conn, bot_id)
            .ok()
            .flatten()
            .map(|b| b.name)
            .unwrap_or_else(|| bot_id.to_string());
        // purge_memory stays false: deleting what a bot remembers is the
        // owner's decision (the editor asks explicitly).
        match db::bots::delete_bot(&conn, bot_id, false) {
            Ok(o) => (name, o),
            Err(e) => return format!("Could not delete the bot: {e}"),
        }
    };
    emit_changed(app, "deleted", bot_id);
    format!(
        "Deleted \"{name}\". Removed {} standing job(s) and {} run(s); its conversation stays in \
         chat history as a normal chat, and its {} memories are kept (the user can purge them).",
        outcome.jobs_deleted, outcome.runs_deleted, outcome.memories
    )
}

fn run(app: &AppHandle, args: &Value) -> String {
    let Some(bot_id) = str_arg(args, "bot_id") else {
        return "run_bot needs a `bot_id`.".to_string();
    };
    match crate::bot_runs::start_run_async(app, bot_id, str_arg(args, "prompt"), "manual", "Run from chat")
    {
        Ok((_run_id, session_id, _prompt)) => {
            emit_changed(app, "run", bot_id);
            format!(
                "Run started in its own session ({session_id}) — read-only work runs now; any \
                 write action it wants is queued for the user's approval instead of executing. \
                 A summary will land in the bot's thread."
            )
        }
        Err(e) => format!("Could not start the run: {e}"),
    }
}

async fn ask(app: &AppHandle, args: &Value) -> String {
    let Some(bot_id) = str_arg(args, "bot_id") else {
        return "ask_bot needs a `bot_id`.".to_string();
    };
    let Some(question) = str_arg(args, "question") else {
        return "ask_bot needs a `question`.".to_string();
    };
    let app2 = app.clone();
    let bot = bot_id.to_string();
    let q = question.to_string();
    // A delegated answer is a whole headless turn — run it off the async
    // runtime so the calling turn (and the UI) stays responsive.
    let result = tokio::task::spawn_blocking(move || crate::bot_runs::ask_bot(&app2, &bot, &q)).await;
    match result {
        Ok(Ok(answer)) => {
            let trimmed = answer.trim();
            if trimmed.is_empty() {
                "The bot finished without a reply.".to_string()
            } else {
                format!("{}\n\n(from a run session — any write it wanted is queued for approval)", trimmed)
            }
        }
        Ok(Err(e)) => format!("The bot could not answer: {e}"),
        Err(e) => format!("The delegated run failed: {e}"),
    }
}

/// A one-line summary for the approval card family (kept next to the handlers
/// so the wording tracks the tool set). `chat::bot_policy::summarize_tool_call`
/// delegates the bot family here and is the deterministic fallback for every
/// other family.
pub(crate) fn bot_tool_summary(name: &str, args: &Value) -> String {
    match name {
        CREATE_BOT => {
            let n = str_arg(args, "name").unwrap_or("(unnamed)");
            format!("Create bot \"{n}\" (disabled until you approve it)")
        }
        UPDATE_BOT => {
            let fields: Vec<&str> = ["name", "description", "emoji", "pet", "persona", "provider", "model"]
                .into_iter()
                .filter(|k| str_arg(args, k).is_some())
                .collect();
            format!("Update bot {} ({})", str_arg(args, "bot_id").unwrap_or("?"), fields.join(", "))
        }
        DELETE_BOT => format!("Delete bot {}", str_arg(args, "bot_id").unwrap_or("?")),
        RUN_BOT => format!("Run bot {} now", str_arg(args, "bot_id").unwrap_or("?")),
        _ => json!({ "tool": name }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bot_tool_classification() {
        assert!(is_bot_tool(LIST_BOTS));
        assert!(is_bot_tool(ASK_BOT));
        assert!(!is_bot_tool("read_file"));
        assert!(!is_mutating_bot_tool(LIST_BOTS));
        assert!(!is_mutating_bot_tool(ASK_BOT), "ask_bot is read-class: the delegated run is gated");
        assert!(is_mutating_bot_tool(CREATE_BOT));
        assert!(is_mutating_bot_tool(UPDATE_BOT));
        assert!(is_mutating_bot_tool(DELETE_BOT));
        assert!(is_mutating_bot_tool(RUN_BOT));
    }

    #[test]
    fn summaries_name_the_target() {
        let s = bot_tool_summary(CREATE_BOT, &json!({"name": "Atlas"}));
        assert!(s.contains("Atlas"));
        let s = bot_tool_summary(DELETE_BOT, &json!({"bot_id": "bot-9"}));
        assert!(s.contains("bot-9"));
    }
}
