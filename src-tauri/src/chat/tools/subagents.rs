//! Chat tools for the Subagent feature (declarative subagents — see
//! `chat/subagent.rs` + the research doc). The registry CRUD (chat::subagent) and its
//! commands (commands::subagent_cmds) are UI-facing; this module exposes the same
//! operations to the model so "create me an agent that reviews PRs" produces
//! a real definition instead of a "I can't do that" reply.
//!
//! Execution reaches the DB through the AppHandle (`DbState`), so these
//! handlers are routed from `dispatch::run_tool` and never in the
//! provider-agnostic `execute_tool` — the same split the automations family
//! uses. Consent posture mirrors automations too: authoring (create/update)
//! and deleting an agent are approval-carded in EVERY posture, so an agent
//! can never exist (or vanish) that the user didn't explicitly click yes on.
//!
//! Rows the MODEL creates carry `origin = "agent"` (mirroring agent-created
//! automations) so the Subagent panel can always show what the agents made.

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{CREATE_SUBAGENT, DELETE_SUBAGENT, LIST_SUBAGENTS, UPDATE_SUBAGENT};

/// Dispatch a subagent-family tool call. Permission gating (postures, plan mode)
/// is the caller's job — see dispatch.rs; everything that reaches here has
/// already been approved to run.
pub(crate) async fn execute_subagent_tool<R: tauri::Runtime>(
    app: &AppHandle<R>,
    name: &str,
    args: &Value,
) -> String {
    match name {
        LIST_SUBAGENTS => list_subagents(app),
        CREATE_SUBAGENT => create_subagent(app, args),
        UPDATE_SUBAGENT => update_subagent(app, args),
        DELETE_SUBAGENT => delete_subagent(app, args),
        _ => format!("Error: unknown subagent tool {name}"),
    }
}

/// True when `name` is one of the subagent tools — used by the dispatcher to
/// route and by the permission/plan gates to classify the family.
pub(crate) fn is_subagent_tool(name: &str) -> bool {
    matches!(
        name,
        LIST_SUBAGENTS | CREATE_SUBAGENT | UPDATE_SUBAGENT | DELETE_SUBAGENT
    )
}

/// Mutating members of the family (everything but the read-only list). The
/// plan gate treats these like any other state-changing tool.
pub(crate) fn is_mutating_subagent_tool(name: &str) -> bool {
    matches!(name, CREATE_SUBAGENT | UPDATE_SUBAGENT | DELETE_SUBAGENT)
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn arg_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}

/// Every definition, builtins first — the same JSON shape the Subagent panel's
/// IPC list returns, so the model and the UI see one truth.
fn list_subagents<R: tauri::Runtime>(app: &AppHandle<R>) -> String {
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    let rows = crate::chat::subagents::list(&conn);
    match serde_json::to_string_pretty(&rows) {
        Ok(json) => json,
        Err(e) => format!("Error: could not serialize the subagent list: {e}"),
    }
}

/// Assemble a `SubagentInput` from tool args. `base` (update path only)
/// supplies every field the caller omitted, so "also let it write files" is a
/// one-field edit instead of a full re-POST — and a partial update can never
/// accidentally wipe the prompt body or allowlist.
fn input_from_args(base: Option<&crate::db::Subagent>, args: &Value) -> crate::db::SubagentInput {
    let get_str = |key: &str, fallback: &str| -> String {
        arg_str(args, key).unwrap_or_else(|| fallback.to_string())
    };
    let get_opt = |key: &str, fallback: &Option<String>| -> Option<String> {
        arg_str(args, key).or_else(|| fallback.clone())
    };
    let get_i64 = |key: &str, fallback: i64| -> i64 { arg_i64(args, key).unwrap_or(fallback) };
    let empty = String::new();
    let none: Option<String> = None;
    crate::db::SubagentInput {
        name: get_str("name", base.map(|b| b.name.as_str()).unwrap_or(&empty)),
        description: get_str(
            "description",
            base.map(|b| b.description.as_str()).unwrap_or(&empty),
        ),
        prompt_md: get_str(
            "prompt_md",
            base.map(|b| b.prompt_md.as_str()).unwrap_or(&empty),
        ),
        // tools: absent = keep base; explicit null = clear to engine default;
        // array = replace (validated by validate_input).
        tools: match args.get("tools") {
            None => base.and_then(|b| b.tools.clone()),
            Some(v) if v.is_null() => None,
            Some(v) => serde_json::to_string(v).ok(),
        },
        engine: get_opt("engine", base.map(|b| &b.engine).unwrap_or(&none)),
        model: get_opt("model", base.map(|b| &b.model).unwrap_or(&none)),
        effort: get_opt("effort", base.map(|b| &b.effort).unwrap_or(&none)),
        sandbox_policy: get_str(
            "sandbox_policy",
            base.map(|b| b.sandbox_policy.as_str()).unwrap_or("read_only"),
        ),
        approval_policy: get_str(
            "approval_policy",
            base.map(|b| b.approval_policy.as_str()).unwrap_or("on_request"),
        ),
        worktree_policy: get_str(
            "worktree_policy",
            base.map(|b| b.worktree_policy.as_str()).unwrap_or("inherit"),
        ),
        max_rounds: get_i64(
            "max_rounds",
            base.map(|b| b.max_rounds).unwrap_or(crate::chat::subagents::MAX_ROUNDS),
        ),
        max_concurrent: get_i64("max_concurrent", base.map(|b| b.max_concurrent).unwrap_or(2)),
    }
}

fn create_subagent<R: tauri::Runtime>(app: &AppHandle<R>, args: &Value) -> String {
    let db = app.state::<crate::DbState>();
    let input = input_from_args(None, args);
    let created = {
        let conn = db.0.lock();
        crate::chat::subagents::create(&conn, &input).and_then(|row| {
            // Mark agent-authored rows (mirrors agent-created automations) so
            // the Subagent panel can always show what the agents made.
            crate::db::set_subagent_origin(&conn, &row.id, Some("agent"))
                .map(|_| row)
                .map_err(|e| e.to_string())
        })
    };
    match created {
        Ok(row) => format!(
            "Created subagent \"{}\" (id {}). It is spawnable now: Task(subagent_type=\"{}\"), \
             spawn_session(agent=\"agent:{}\"), and automations (harness=\"agent:{}\").{}",
            row.name,
            row.id,
            row.name,
            row.id,
            row.id,
            if row.sandbox_policy == "workspace_write" {
                " Note: it holds workspace-write tools, so its writes stay inside the bound \
                 project root."
            } else {
                ""
            }
        ),
        Err(e) => format!("Error: create_subagent: {e}"),
    }
}

fn update_subagent<R: tauri::Runtime>(app: &AppHandle<R>, args: &Value) -> String {
    let agent_ref = match arg_str(args, "agent_id") {
        Some(v) => v,
        None => return "Error: update_subagent requires `agent_id` (id or name)".into(),
    };
    let db = app.state::<crate::DbState>();
    let existing = {
        let conn = db.0.lock();
        crate::chat::subagents::resolve_by_id_or_name(&conn, &agent_ref)
    };
    let Some(existing) = existing else {
        return format!("Error: subagent \"{agent_ref}\" not found");
    };
    let input = input_from_args(Some(&existing), args);
    let updated = {
        let conn = db.0.lock();
        crate::chat::subagents::update(&conn, &existing.id, &input)
    };
    match updated {
        Ok(row) => format!(
            "Updated subagent \"{}\" (id {}). Its next run — and any in-session Task call \
             that names it — uses the new definition.",
            row.name, row.id
        ),
        Err(e) => format!("Error: update_subagent: {e}"),
    }
}

fn delete_subagent<R: tauri::Runtime>(app: &AppHandle<R>, args: &Value) -> String {
    let agent_ref = match arg_str(args, "agent_id") {
        Some(v) => v,
        None => return "Error: delete_subagent requires `agent_id` (id or name)".into(),
    };
    let db = app.state::<crate::DbState>();
    let resolved = {
        let conn = db.0.lock();
        crate::chat::subagents::resolve_by_id_or_name(&conn, &agent_ref)
    };
    let Some(existing) = resolved else {
        return format!("Error: subagent \"{agent_ref}\" not found");
    };
    let result = {
        let conn = db.0.lock();
        crate::chat::subagents::delete(&conn, &existing.id)
    };
    match result {
        Ok(()) => format!(
            "Deleted subagent \"{}\". Its past run sessions remain in the sidebar (the \
             history is the user's data); their agent link now shows as deleted.",
            existing.name
        ),
        Err(e) => format!("Error: delete_subagent: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_with_db() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        let conn = crate::db::mem();
        app.manage(crate::DbState(std::sync::Arc::new(
            parking_lot::Mutex::new(conn),
        )));
        app.handle().clone()
    }

    #[test]
    fn create_update_delete_round_trip_marks_agent_origin() {
        let app = app_with_db();
        let out = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(execute_subagent_tool(
                &app,
                CREATE_SUBAGENT,
                &serde_json::json!({
                    "name": "pr-reviewer",
                    "description": "Reviews pull requests",
                    "prompt_md": "Review the diff. Be terse.",
                    "engine": "builtin",
                    "model": "openrouter::test/model",
                }),
            ));
        assert!(out.contains("Created subagent"), "{out}");
        assert!(out.contains("pr-reviewer"), "{out}");

        let db = app.state::<crate::DbState>();
        let (id, origin) = {
            let conn = db.0.lock();
            let row = crate::chat::subagents::resolve_by_id_or_name(&conn, "pr-reviewer").unwrap();
            let origin: Option<String> = conn
                .query_row(
                    "SELECT origin FROM subagents WHERE id = ?1",
                    [&row.id],
                    |r| r.get(0),
                )
                .unwrap();
            (row.id, origin)
        };
        assert_eq!(origin.as_deref(), Some("agent"), "model-created rows are marked");

        // Partial update: only the prompt changes; the allowlist/engine stay.
        let out = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(execute_subagent_tool(
                &app,
                UPDATE_SUBAGENT,
                &serde_json::json!({ "agent_id": "pr-reviewer", "prompt_md": "Review harder." }),
            ));
        assert!(out.contains("Updated"), "{out}");
        {
            let conn = db.0.lock();
            let row = crate::chat::subagents::resolve_by_id_or_name(&conn, "pr-reviewer").unwrap();
            assert_eq!(row.prompt_md, "Review harder.");
            assert_eq!(row.engine.as_deref(), Some("builtin"));
            assert_eq!(row.model.as_deref(), Some("openrouter::test/model"));
        }

        // Delete by name.
        let out = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(execute_subagent_tool(
                &app,
                DELETE_SUBAGENT,
                &serde_json::json!({ "agent_id": "pr-reviewer" }),
            ));
        assert!(out.contains("Deleted"), "{out}");
        let conn = db.0.lock();
        assert!(crate::chat::subagents::resolve_by_id_or_name(&conn, &id).is_none());
    }

    #[test]
    fn builtin_rows_are_not_deletable_by_the_model() {
        let app = app_with_db();
        let out = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(execute_subagent_tool(
                &app,
                DELETE_SUBAGENT,
                &serde_json::json!({ "agent_id": "explore" }),
            ));
        assert!(out.contains("Error:"), "{out}");
    }

    #[test]
    fn unknown_tool_and_missing_args_fail_cleanly() {
        let app = app_with_db();
        let out = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(execute_subagent_tool(&app, "subagent_nope", &serde_json::json!({})));
        assert!(out.contains("unknown subagent tool"), "{out}");
        let out = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(execute_subagent_tool(
                &app,
                UPDATE_SUBAGENT,
                &serde_json::json!({}),
            ));
        assert!(out.contains("requires `agent_id`"), "{out}");
        // A builtin role name cannot be taken by a new agent (reserved).
        let out = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(execute_subagent_tool(
                &app,
                CREATE_SUBAGENT,
                &serde_json::json!({ "name": "explore" }),
            ));
        assert!(out.contains("built-in role name"), "{out}");
    }
}
