// bot_policy — the permission policy for UNATTENDED bot runs
// (docs/architecture/BOTS.md §Unattended permissions).
//
// A standing job, `run_bot` or `ask_bot` run has no human watching, and its
// input may be untrusted (a webhook, a file that changed on disk). So a
// background run never executes a write-class tool: it queues a
// `bot_approvals` row and returns a synthetic tool result telling the model
// to move on. Read-class tools run normally, and an INTERACTIVE turn in the
// bot's own thread keeps the ordinary approval-card UX — the gate is keyed on
// `bot_role = 'run'`, which only ever holds for headless executions.
//
// The gate applies only to sessions that belong to a bot. Every other session
// (and every session with no `bot_id`) takes exactly the path it took before
// bots existed.

use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOrigin {
    /// A live chat turn: the user is right there, ordinary approval applies.
    Interactive,
    /// A headless execution: a standing job, run_bot, ask_bot.
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Proceed on the normal path.
    Allow,
    /// Do not execute; queue an approval row for the owner.
    QueueApproval,
    /// Tools are switched off for this bot — refuse outright.
    Deny,
}

/// The whole policy, as a pure function (unit-tested below).
///
/// Interactive turns keep their existing approval UX even for a bot whose
/// tools are on — the user is watching, so there is nothing to protect them
/// from. A background run runs reads and queues writes.
pub fn gate(origin: RunOrigin, is_write_class: bool, bot_tools_enabled: bool) -> Gate {
    if !bot_tools_enabled {
        return Gate::Deny;
    }
    match (origin, is_write_class) {
        (RunOrigin::Background, true) => Gate::QueueApproval,
        _ => Gate::Allow,
    }
}

/// Whether a tool can change user-visible state. One list, borrowed from the
/// plan gate (`chat::plan::is_mutating_tool`) — which already covers the
/// filesystem writes, run_shell/run_code, automations, subagents, Session
/// Mesh writes, vault writes, the mutating browser ops and Relay self-control.
///
/// Deliberately NOT write-class here: the memory tools. A bot's
/// `memory_save` / `memory_forget` can only touch the bot's own profile
/// (`bot:<id>`, enforced in the tool handlers), so queueing them would mean a
/// standing job could never remember anything — while a prompt-injected run
/// still cannot reach the user's `default` memory.
pub fn is_write_class(name: &str) -> bool {
    crate::chat::plan::is_mutating_tool(name)
}

/// A one-line, DETERMINISTIC summary of a tool call for the approval card.
///
/// Never model-written text: a prompt-injected run must not be able to
/// disguise what it is asking for. Two calls with the same name + args produce
/// byte-identical summaries.
pub fn summarize_tool_call(name: &str, args: &Value) -> String {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let clipped = |v: &str, max: usize| -> String {
        let clean: String = v.split_whitespace().collect::<Vec<_>>().join(" ");
        if clean.chars().count() <= max {
            clean
        } else {
            let head: String = clean.chars().take(max).collect();
            format!("{head}…")
        }
    };
    let labelled = |what: &str, arg: &str| format!("{what} \"{}\"", clipped(arg, 80));

    match name {
        "write_file" | "Write" => labelled("Write file", s("path")),
        "edit_file" | "Edit" => labelled("Edit file", s("path")),
        "delete_file" => labelled("Delete file", s("path")),
        "move_file" => format!("\"{}\" → \"{}\"", clipped(s("source"), 60), clipped(s("destination"), 60)),
        "copy_file" => format!("Copy \"{}\" → \"{}\"", clipped(s("source"), 60), clipped(s("destination"), 60)),
        "run_shell" | "shell" | "RunShell" => {
            let cmd = s("command");
            let cmd = if cmd.is_empty() { s("cmd") } else { cmd };
            format!("Run shell: {}", clipped(cmd, 120))
        }
        "run_code" => format!("Run {} code", {
            let lang = s("language");
            if lang.is_empty() { "code".to_string() } else { lang.to_string() }
        }),
        "create_automation" => {
            let n = s("name");
            if n.is_empty() { "Create a standing job".to_string() } else { labelled("Create standing job", n) }
        }
        "update_automation" => labelled("Update standing job", s("name")),
        "delete_automation" => labelled("Delete standing job", s("name")),
        "run_automation_now" => labelled("Run standing job now", s("automation_id")),
        "create_subagent" => labelled("Create subagent", s("name")),
        "delete_subagent" => labelled("Delete subagent", s("name")),
        "spawn_session" | "spawn_agent" => {
            let task = s("task");
            let task = if task.is_empty() { s("prompt") } else { task };
            format!("Start an agent: {}", clipped(task, 120))
        }
        "send_session_message" | "message_session" => labelled("Message another session", s("session_id")),
        "create_vault_note" => labelled("Create vault note", s("title")),
        "update_vault_note" | "append_vault_note" => labelled("Update vault note", s("path")),
        "delete_vault_note" => labelled("Delete vault note", s("path")),
        "browser_click" | "browser_type" | "browser_fill_form" | "browser_upload_file" => {
            format!("Control the browser ({name})")
        }
        "app_click" | "app_type" | "app_press_key" | "app_select_option" => {
            format!("Control Relay's UI ({name})")
        }
        "attach_connector" | "attach_mcp_server" => labelled("Attach a connector", s("name")),
        // The bot family carries its own wording ("Create bot \"X\" (disabled
        // until you approve it)") — reuse it so the approval card reads well.
        name if crate::chat::tools::is_bot_tool(name) => {
            crate::chat::tools::bot_tool_summary(name, args)
        }
        _ => {
            // Generic but still deterministic: the declared arguments, clipped.
            let mut parts: Vec<String> = Vec::new();
            if let Some(map) = args.as_object() {
                for (k, v) in map.iter() {
                    let rendered = match v {
                        Value::String(text) => clipped(text, 60),
                        Value::Number(n) => n.to_string(),
                        Value::Bool(b) => b.to_string(),
                        Value::Null => continue,
                        other => clipped(&other.to_string(), 60),
                    };
                    parts.push(format!("{k}: {rendered}"));
                    if parts.len() == 3 {
                        break;
                    }
                }
            }
            if parts.is_empty() {
                name.to_string()
            } else {
                format!("{name} ({})", parts.join(", "))
            }
        }
    }
}

/// The synthetic tool result a queued call returns to the model. Wording is
/// deliberate: it tells the model the action did NOT run AND not to retry, so
/// a standing job finishes its remaining reads instead of looping on a refusal.
pub fn queued_result_text(approval_id: &str, summary: &str) -> String {
    format!(
        "Queued for the owner's approval (id {approval_id}): {summary}. \
         This action has NOT run and will not run until the owner approves it. \
         Do not retry it — finish the rest of your task and mention it in your summary."
    )
}

pub fn denied_result_text() -> String {
    "Tools are disabled for this bot. Answer without taking actions.".to_string()
}

/// The dispatch-time hook. Returns `Some(synthetic tool result)` when the call
/// was queued (and must NOT execute), `None` when the caller should proceed
/// down its normal path.
///
/// Fail-open on infrastructure problems (an unreadable session row just means
/// "not a bot run"): the alternative is a broken DB turning every tool call
/// into a refusal. Fail-CLOSED on the policy itself: once we know this is a
/// background bot run, a failed insert still refuses the call.
pub fn queue_if_background_write(app: &AppHandle, sid: &str, name: &str, args: &Value) -> Option<String> {
    let db = app.state::<crate::DbState>();
    let (bot_id, tools_enabled) = {
        let conn = db.0.lock();
        let cs = match crate::db::get_chat_session(&conn, sid) {
            Ok(Some(cs)) => cs,
            _ => return None,
        };
        // Only a run session is background; a bot's thread is a live chat.
        if cs.bot_role.as_deref() != Some("run") {
            return None;
        }
        let bot_id = cs.bot_id.clone()?;
        let enabled = crate::db::bots::tools_allowed(&conn, sid).unwrap_or(true);
        (bot_id, enabled)
    };
    if !is_write_class(name) {
        return None;
    }
    let summary = summarize_tool_call(name, args);
    if gate(RunOrigin::Background, true, tools_enabled) == Gate::Deny {
        return Some(denied_result_text());
    }
    let row = {
        let conn = db.0.lock();
        crate::db::bot_approvals::insert_approval(
            &conn,
            &bot_id,
            sid,
            name,
            &args.to_string(),
            &summary,
        )
    };
    let id = match row {
        Ok(id) => id,
        Err(e) => {
            crate::relay_eprintln!("[bots] could not queue approval for {name}: {e}");
            return Some(format!(
                "Refused: this write could not be queued for approval ({e}). It has NOT run."
            ));
        }
    };
    drop(db);
    crate::bot_runs::notify_approval_queued(app, &bot_id, &summary);
    Some(queued_result_text(&id, &summary))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn background_write_is_queued() {
        assert_eq!(
            gate(RunOrigin::Background, true, true),
            Gate::QueueApproval
        );
    }

    #[test]
    fn background_read_runs() {
        assert_eq!(gate(RunOrigin::Background, false, true), Gate::Allow);
    }

    #[test]
    fn interactive_turns_keep_their_own_approval_ux() {
        assert_eq!(gate(RunOrigin::Interactive, true, true), Gate::Allow);
        assert_eq!(gate(RunOrigin::Interactive, false, true), Gate::Allow);
    }

    #[test]
    fn tools_disabled_denies_everything() {
        assert_eq!(gate(RunOrigin::Interactive, false, false), Gate::Deny);
        assert_eq!(gate(RunOrigin::Background, false, false), Gate::Deny);
        assert_eq!(gate(RunOrigin::Background, true, false), Gate::Deny);
    }

    #[test]
    fn write_class_covers_the_mutating_families_only() {
        for w in [
            "write_file",
            "edit_file",
            "run_shell",
            "run_code",
            "create_automation",
            "delete_automation",
            "create_subagent",
            "vault_write",
            "vault_delete",
            "browser_click",
            "app_click",
            "attach_connector",
        ] {
            assert!(is_write_class(w), "{w} should be write-class");
        }
        for r in [
            "read_file",
            "list_files",
            "grep",
            "search_web",
            "list_automations",
            "get_automation",
            "list_vault",
            "vault_read",
            "memory_recall",
            "memory_save",
            "browser_navigate",
        ] {
            assert!(!is_write_class(r), "{r} should not be write-class");
        }
    }

    #[test]
    fn summaries_are_deterministic_and_never_empty() {
        let a = summarize_tool_call("write_file", &json!({"path": "src/main.rs", "content": "x"}));
        let b = summarize_tool_call("write_file", &json!({"path": "src/main.rs", "content": "y"}));
        assert_eq!(a, b, "same args → byte-identical summaries");
        assert!(a.contains("src/main.rs"));

        let shell = summarize_tool_call("run_shell", &json!({"command": "rm -rf   build/"}));
        assert_eq!(shell, "Run shell: rm -rf build/", "whitespace is collapsed");

        let long = summarize_tool_call("run_shell", &json!({"command": "x".repeat(500)}));
        assert!(long.chars().count() < 160, "summaries stay one line");

        let generic = summarize_tool_call("some_new_tool", &json!({"a": 1, "b": "two"}));
        assert_eq!(generic, "some_new_tool (a: 1, b: two)");
        let bare = summarize_tool_call("mystery", &json!({}));
        assert_eq!(bare, "mystery");
    }

    #[test]
    fn queued_text_forbids_retries() {
        let text = queued_result_text("appr-1", "Create vault note \"Standup\"");
        assert!(text.contains("appr-1"));
        assert!(text.contains("has NOT run"));
        assert!(text.contains("Do not retry"));
    }
}
