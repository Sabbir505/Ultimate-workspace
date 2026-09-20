//! Chat tools for the Automations feature (see the family block in
//! `tools/mod.rs`). The scheduler (crate::automations) and its CRUD commands
//! (commands::automation_cmds) are UI-facing; this module exposes the same
//! operations to the model so a "schedule X every morning" request produces a
//! real automation instead of a "I can't do that" reply.
//!
//! Execution reaches the DB and the scheduler through the AppHandle
//! (`DbState`), so these handlers are routed from `dispatch::run_tool` and
//! never in the provider-agnostic `execute_tool` — the same split the
//! source-ledger tools use.

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{
    CREATE_AUTOMATION, DELETE_AUTOMATION, GET_AUTOMATION, LIST_AUTOMATIONS, RUN_AUTOMATION_NOW,
    UPDATE_AUTOMATION,
};

/// Dispatch an automation-family tool call. Permission gating (read-only vs
/// mutating postures, plan mode) is the caller's job — see dispatch.rs;
/// everything that reaches here has already been approved to run.
pub(crate) async fn execute_automation_tool(app: &AppHandle, name: &str, args: &Value) -> String {
    match name {
        LIST_AUTOMATIONS => list_automations(app),
        GET_AUTOMATION => get_automation(app, args),
        CREATE_AUTOMATION => create_automation(app, args),
        UPDATE_AUTOMATION => update_automation(app, args),
        DELETE_AUTOMATION => delete_automation(app, args),
        RUN_AUTOMATION_NOW => run_automation_now(app, args),
        _ => format!("Error: unknown automation tool {name}"),
    }
}

/// True when `name` is one of the automation tools — used by the dispatcher
/// to route and by the permission/plan gates to classify the family.
pub(crate) fn is_automation_tool(name: &str) -> bool {
    matches!(
        name,
        LIST_AUTOMATIONS
            | GET_AUTOMATION
            | CREATE_AUTOMATION
            | UPDATE_AUTOMATION
            | DELETE_AUTOMATION
            | RUN_AUTOMATION_NOW
    )
}

/// Mutating members of the family (everything but the read-only list). The
/// plan gate treats these like any other state-changing tool.
pub(crate) fn is_mutating_automation_tool(name: &str) -> bool {
    matches!(
        name,
        CREATE_AUTOMATION | UPDATE_AUTOMATION | DELETE_AUTOMATION | RUN_AUTOMATION_NOW
    )
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn arg_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|v| v.as_bool())
}

fn format_next_fire(schedule: &str) -> Option<String> {
    // For a fresh human-readable preview, "next fire after now" is what the
    // user wants to hear; the scheduler's own due-ness math (from the last
    // run) lives in automations::due_automations.
    let ts = crate::automations::next_fire(schedule, crate::db::now_ts())?;
    let dt = chrono::DateTime::from_timestamp(ts, 0)?.with_timezone(&chrono::Local);
    Some(dt.format("%a %Y-%m-%d %H:%M").to_string())
}

fn list_automations(app: &AppHandle) -> String {
    let rows = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        crate::db::list_automations(&conn)
    };
    match rows {
        Ok(rows) if rows.is_empty() => {
            "No automations exist yet. Create one with create_automation (name, prompt, \
             schedule) — it appears in the app's Automations view."
                .to_string()
        }
        Ok(rows) => {
            let mut out = String::from("## Automations\n");
            for a in &rows {
                let next = if a.enabled {
                    format_next_fire(&a.schedule)
                        .map(|t| format!("; next run {t}"))
                        .unwrap_or_else(|| "; schedule error — will not fire".to_string())
                } else {
                    "; disabled".to_string()
                };
                let status = a.last_status.as_deref().unwrap_or("never run");
                out.push_str(&format!(
                    "- {} `{}` — agent `{}`, cron `{}`{}; last run: {status}\n  prompt: {}\n",
                    a.name,
                    a.id,
                    a.harness,
                    a.schedule,
                    next,
                    one_line(&a.prompt),
                ));
            }
            out.push_str(
                "Prompts are truncated here — read one in full with get_automation. \
                 Update with update_automation, delete with delete_automation, \
                 fire now with run_automation_now.",
            );
            out
        }
        Err(e) => format!("Error: list_automations failed: {e}"),
    }
}

/// One-line summary of a stored prompt for the list output.
fn one_line(s: &str) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= 160 {
        flat
    } else {
        let cut: String = flat.chars().take(157).collect();
        format!("{cut}...")
    }
}

/// Read one automation in FULL — the complete prompt included. This is the
/// read half of an "edit my automation" turn: update_automation overwrites
/// whole fields, so appending a step means seeing the stored text verbatim
/// first (the list's 160-char one-liner cannot be reconstructed from, and
/// guessing at it silently drops content).
fn get_automation(app: &AppHandle, args: &Value) -> String {
    let id = arg_str(args, "automation_id");
    if id.is_empty() {
        return "Error: get_automation requires \"automation_id\" (from \
             list_automations)."
            .to_string();
    }
    let a = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        crate::db::get_automation(&conn, &id)
    };
    match a {
        Ok(Some(a)) => format_automation_detail(&a),
        Ok(None) => format!("Error: no automation with id \"{id}\"."),
        Err(e) => format!("Error: get_automation failed: {e}"),
    }
}

/// The full get_automation report for one stored row. The prompt must come
/// back VERBATIM — update_automation replaces whole fields, so the caller
/// copies this text through with only its intended edits applied.
fn format_automation_detail(a: &crate::db::Automation) -> String {
    let next = if a.enabled {
        format_next_fire(&a.schedule)
            .map(|t| format!("; next run {t}"))
            .unwrap_or_else(|| "; schedule error — will not fire".to_string())
    } else {
        "; disabled".to_string()
    };
    let status = a.last_status.as_deref().unwrap_or("never run");
    let origin = match a.origin.as_str() {
        "agent" => "agent-authored (chat approval card)",
        "user" => "user-authored (Automations view)",
        other => other,
    };
    format!(
        "# {}\n\
         - id: `{}`\n\
         - agent: `{}`{}\n\
         - cwd: {}\n\
         - cron: `{}`{}\n\
         - enabled: {}; last run: {status}\n\
         - origin: {origin}\n\
         \n\
         ## Prompt (verbatim — pass it back unchanged through update_automation's \
         `prompt` field, with your edits applied)\n\
         \n\
         {}",
        a.name,
        a.id,
        a.harness,
        if a.model.is_empty() {
            String::new()
        } else {
            format!(" (model: `{}`)", a.model)
        },
        if a.cwd.is_empty() {
            "(none — harness default)".to_string()
        } else {
            format!("`{}`", a.cwd)
        },
        a.schedule,
        next,
        if a.enabled { "yes" } else { "no" },
        a.prompt,
    )
}

fn validate_automation_input(
    name: &str,
    prompt: &str,
    schedule: &str,
    agent: &str,
) -> Result<(), String> {
    if name.is_empty() {
        return Err("Error: create_automation requires a non-empty \"name\".".into());
    }
    if prompt.is_empty() {
        return Err(
            "Error: create_automation requires a non-empty \"prompt\" — it is the \
             full instruction the automation runs unattended."
                .into(),
        );
    }
    if !crate::commands::automation_cmds::is_allowed_automation_agent(agent) {
        return Err(format!(
            "Error: agent \"{agent}\" cannot run automations. Use one of: \
             claude_code, opencode, pi, omp, commandcode, anthropic, openai, \
             openrouter, anthropic_compatible, openai_compatible, local_gguf."
        ));
    }
    crate::automations::validate_schedule(schedule)
        .map_err(|e| format!("Error: create_automation: {e}"))
}

fn create_automation(app: &AppHandle, args: &Value) -> String {
    let name = arg_str(args, "name");
    let prompt = arg_str(args, "prompt");
    let schedule = arg_str(args, "schedule");
    // Default mirrors the Automations form's first agent option.
    let agent = {
        let a = arg_str(args, "agent");
        if a.is_empty() {
            "claude_code".to_string()
        } else {
            a
        }
    };
    let enabled = arg_bool(args, "enabled").unwrap_or(true);
    if let Err(e) = validate_automation_input(&name, &prompt, &schedule, &agent) {
        return e;
    }
    let input = crate::db::AutomationInput {
        name,
        prompt,
        harness: agent,
        model: None,
        cwd: None,
        schedule: schedule.clone(),
        enabled: Some(enabled),
        // Authored by the model — the Automations view badges these rows, and
        // the dispatch gate already required an explicit user approval card
        // for THIS tool call (in every permission posture) before we got here.
        origin: Some("agent".into()),
    };
    let created = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        crate::db::create_automation(&conn, &input)
    };
    match created {
        Ok(a) => {
            let next = format_next_fire(&a.schedule)
                .map(|t| format!(" Next run: {t}."))
                .unwrap_or_default();
            format!(
                "Created automation \"{}\" (id `{}`) — agent `{}`, cron `{}`, {}. \
                 It fires on schedule while the app runs (one catch-up run after a \
                 missed window); every run is logged to its own chat session and the \
                 app's Automations view.{next}",
                a.name,
                a.id,
                a.harness,
                a.schedule,
                if a.enabled { "enabled" } else { "disabled" },
            )
        }
        Err(e) => format!("Error: create_automation failed: {e}"),
    }
}

fn update_automation(app: &AppHandle, args: &Value) -> String {
    let id = arg_str(args, "automation_id");
    if id.is_empty() {
        return "Error: update_automation requires \"automation_id\" (from \
             list_automations)."
            .to_string();
    }
    let existing = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        crate::db::get_automation(&conn, &id)
    };
    let existing = match existing {
        Ok(Some(a)) => a,
        Ok(None) => return format!("Error: no automation with id \"{id}\"."),
        Err(e) => return format!("Error: update_automation failed: {e}"),
    };
    // Partial update: absent fields keep their stored values. The DB update
    // overwrites every column, so the row must be re-fetched and merged here.
    let name = {
        let n = arg_str(args, "name");
        if n.is_empty() {
            existing.name.clone()
        } else {
            n
        }
    };
    let prompt = {
        let p = arg_str(args, "prompt");
        if p.is_empty() {
            existing.prompt.clone()
        } else {
            p
        }
    };
    let schedule = {
        let s = arg_str(args, "schedule");
        if s.is_empty() {
            existing.schedule.clone()
        } else {
            s
        }
    };
    let agent = {
        let a = arg_str(args, "agent");
        if a.is_empty() {
            existing.harness.clone()
        } else {
            a
        }
    };
    // model/cwd merge the same way: absent → keep the stored value. They
    // used to be hardcoded to None here, which the DB layer writes as "",
    // silently WIPING the stored model/working-directory on every agent
    // update ("only passed fields change" was a lie for these two). An
    // EXPLICIT "" resets to the harness default / clears, per the schema —
    // so presence, not emptiness, is what decides.
    let model = match args.get("model") {
        Some(Value::String(m)) => Some(m.clone()),
        _ if existing.model.is_empty() => None,
        _ => Some(existing.model.clone()),
    };
    let cwd = match args.get("cwd") {
        Some(Value::String(c)) => Some(c.clone()),
        _ if existing.cwd.is_empty() => None,
        _ => Some(existing.cwd.clone()),
    };
    if let Err(e) = validate_automation_input(&name, &prompt, &schedule, &agent) {
        // Same validation as create, with the tool name corrected.
        return e.replace("create_automation", "update_automation");
    }
    let result: Result<(), String> = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let input = crate::db::AutomationInput {
            name: name.clone(),
            prompt: prompt.clone(),
            harness: agent.clone(),
            model,
            cwd,
            schedule: schedule.clone(),
            enabled: None,
            // Update preserves the row's original origin (the column is not
            // part of the UPDATE).
            origin: None,
        };
        crate::db::update_automation(&conn, &id, &input)
            .map_err(|e| format!("update failed: {e}"))
            .and_then(|_| {
                // update_automation does not touch `enabled` — that column has
                // its own setter. Apply it only when the model asked.
                match arg_bool(args, "enabled") {
                    Some(on) => crate::db::set_automation_enabled(&conn, &id, on)
                        .map_err(|e| format!("enabling failed: {e}")),
                    None => Ok(()),
                }
            })
    };
    match result {
        Ok(()) => {
            let enabled_note = match arg_bool(args, "enabled") {
                Some(true) => " Enabled.",
                Some(false) => " Disabled.",
                None => {
                    if existing.enabled {
                        ""
                    } else {
                        " (still disabled — pass enabled:true to turn it on.)"
                    }
                }
            };
            let next = format_next_fire(&schedule)
                .map(|t| format!(" Next run: {t}."))
                .unwrap_or_default();
            format!(
                "Updated automation \"{name}\" (id `{id}`) — agent `{agent}`, cron \
                 `{schedule}`.{enabled_note}{next}",
            )
        }
        Err(e) => format!("Error: update_automation failed: {e}"),
    }
}

fn delete_automation(app: &AppHandle, args: &Value) -> String {
    let id = arg_str(args, "automation_id");
    if id.is_empty() {
        return "Error: delete_automation requires \"automation_id\" (from \
             list_automations)."
            .to_string();
    }
    let (name, deleted) = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        match crate::db::get_automation(&conn, &id) {
            Ok(Some(a)) => {
                let r = crate::db::delete_automation(&conn, &id);
                (a.name, r)
            }
            Ok(None) => return format!("Error: no automation with id \"{id}\"."),
            Err(e) => return format!("Error: delete_automation failed: {e}"),
        }
    };
    match deleted {
        Ok(()) => format!("Deleted automation \"{name}\" (id `{id}`)."),
        Err(e) => format!("Error: delete_automation failed: {e}"),
    }
}

fn run_automation_now(app: &AppHandle, args: &Value) -> String {
    let id = arg_str(args, "automation_id");
    if id.is_empty() {
        return "Error: run_automation_now requires \"automation_id\" (from \
             list_automations)."
            .to_string();
    }
    let automation = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        crate::db::get_automation(&conn, &id)
    };
    let automation = match automation {
        Ok(Some(a)) => a,
        Ok(None) => return format!("Error: no automation with id \"{id}\"."),
        Err(e) => return format!("Error: run_automation_now failed: {e}"),
    };
    // Same launch path the scheduler tick and the Run-now button use. The run
    // continues on its own thread; the outcome lands in the run history.
    let db = app.state::<crate::DbState>();
    let launched = crate::automations::launch_run(
        Some(app),
        &db.0,
        &automation,
        crate::automations::RunSource::Manual,
    );
    match launched {
        Ok(()) => format!(
            "Run started for \"{}\" (id `{id}`) — it executes unattended in the \
             background and is logged to the automation's run history (Automations \
             view); a still-running previous run is skipped instead of queued.",
            automation.name,
        ),
        Err(e) => format!("Error: run_automation_now failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_classification() {
        assert!(is_automation_tool(LIST_AUTOMATIONS));
        assert!(is_automation_tool(RUN_AUTOMATION_NOW));
        assert!(!is_automation_tool("write_file"));
        // Only the non-list members count as mutating.
        assert!(!is_mutating_automation_tool(LIST_AUTOMATIONS));
        for t in [
            CREATE_AUTOMATION,
            UPDATE_AUTOMATION,
            DELETE_AUTOMATION,
            RUN_AUTOMATION_NOW,
        ] {
            assert!(is_mutating_automation_tool(t));
        }
    }

    #[test]
    fn one_line_flattens_and_caps() {
        assert_eq!(one_line("check\n  the\t mail"), "check the mail");
        let long = "x".repeat(300);
        let out = one_line(&long);
        assert_eq!(out.chars().count(), 160);
        assert!(out.ends_with("..."));
    }

    /// get_automation is the edit-turn read path: it must return the stored
    /// prompt VERBATIM (the whole point — list truncates to one_line) plus
    /// the id echo the update call needs. The handler's id plumbing (missing
    /// id / unknown id → the shared guidance errors) is thin; the formatting
    /// carries the contract, so the test pins that.
    #[test]
    fn automation_detail_formats_full_prompt_verbatim() {
        let long_prompt = "Line one of the schedule.\nLine two has \"quotes\" and \
                           backslashes D:\\artifect — beyond the 160-char list cut.\n"
            .repeat(4);
        let a = crate::db::Automation {
            id: "48ea3ef6-0000-0000-0000-000000000000".into(),
            name: "Daily ML Lesson 9AM".into(),
            prompt: long_prompt.clone(),
            harness: "opencode".into(),
            model: String::new(),
            cwd: String::new(),
            schedule: "0 9 * * *".into(),
            enabled: false,
            last_run_at: None,
            last_status: None,
            chat_session_id: None,
            created_at: 0,
            origin: "user".into(),
        };
        let out = format_automation_detail(&a);
        assert!(out.contains(&long_prompt), "prompt must be verbatim");
        assert!(out.contains(a.id.as_str()));
        assert!(out.contains("`opencode`"));
        assert!(out.contains("0 9 * * *"));
        assert!(out.contains("disabled"));
        // The one_line cut would drop the tail — this report must not.
        assert!(!out.contains(&one_line(&long_prompt)));
    }
}
