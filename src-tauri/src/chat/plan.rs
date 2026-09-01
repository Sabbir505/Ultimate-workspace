//! Structured plan tracking for the built-in chat agent.
//!
//! Three session-state tools replace scraping the model's prose for plans:
//!
//!   * `todo_write` — the model rewrites its whole task list (content +
//!     status per item). The list is the user-visible progress state; the UI
//!     renders it as a live checklist card and mirrors it into the sidebar.
//!   * `enter_plan_mode` — model-initiated planning: flips the session into
//!     plan mode (read-only) when the model judges a task complex enough to
//!     need an approved plan first.
//!   * `present_plan` — proposes the plan as an approval card. The turn
//!     pauses on the SAME approval oneshot the gated filesystem/system tools
//!     use (`ChatManager::register_pending_approval`), so there is exactly
//!     one pause-and-resume mechanism. Approving unlocks mutations (plan
//!     mode auto-exits) and seeds the todo list; rejecting returns the user's
//!     feedback to the model so it can revise.
//!
//! Enforcement is at the dispatch gate (`plan::gate_denial`), not the prompt:
//! while plan mode is active every mutating tool is refused with an error the
//! model can self-correct from. Reads, search, and web access stay allowed —
//! plan mode means "no changes without an approved plan", not "no work".

use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::types::{
    ChatPlanAcceptedPayload, ChatPlanModePayload, ChatPlanProposalPayload, ChatPlanUpdatedPayload,
    PlanRecord, PlanTodo,
};

/// Hard ceiling on list size — a runaway model shouldn't ship 500-item lists
/// into the UI (and every rewrite re-renders the card).
pub(crate) const MAX_TODOS: usize = 50;
/// Per-item content cap (chars). Step labels are UI text, not prose.
const MAX_CONTENT_CHARS: usize = 300;
/// Approved plans kept per session (the sidebar Plans list).
const MAX_PLANS: usize = 20;
/// Cap on the plan markdown accepted by present_plan — it renders in the
/// approval card and the Plans list; an unbounded dump would stall both.
const MAX_PLAN_CHARS: usize = 16_000;

/// Tool names, mirrored in `tools::mod` constants — kept here so the plan
/// module owns its dispatch without a circular import.
pub(crate) const TODO_WRITE: &str = "todo_write";
pub(crate) const ENTER_PLAN_MODE: &str = "enter_plan_mode";
pub(crate) const PRESENT_PLAN: &str = "present_plan";

/// Per-session plan state: the authoritative todo list + plan-mode flag.
#[derive(Debug, Default, Clone)]
pub(crate) struct SessionPlan {
    pub todos: Vec<PlanTodo>,
    pub plan_mode: bool,
}

/// Tauri-managed state (`app.manage(PlanState::default())`). One map entry per
/// chat session that has ever used a plan tool; sessions without entries are
/// implicitly "no todos, plan mode off".
pub struct PlanState {
    sessions: Mutex<HashMap<String, SessionPlan>>,
    /// Approved plans per session (newest first) — the sidebar Plans list.
    plans: Mutex<HashMap<String, Vec<PlanRecord>>>,
    /// Rejection feedback for plan proposals, keyed by pending-approval id.
    /// `resolve_plan_proposal` stores the text BEFORE releasing the paused
    /// turn, so the awaiting `present_plan` handler reads it right after the
    /// oneshot resolves (store-then-send ordering makes the race impossible).
    feedback: Mutex<HashMap<String, String>>,
    next_plan_id: Mutex<u64>,
}

impl Default for PlanState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            plans: Mutex::new(HashMap::new()),
            feedback: Mutex::new(HashMap::new()),
            next_plan_id: Mutex::new(1),
        }
    }
}

impl PlanState {
    /// Current todo list snapshot. The UI gets the list via `chat:plan-updated`
    /// events; this accessor exists for tests and future model-facing readout.
    #[allow(dead_code)]
    pub fn todos(&self, sid: &str) -> Vec<PlanTodo> {
        self.sessions.lock().get(sid).map(|s| s.todos.clone()).unwrap_or_default()
    }

    pub fn plan_mode(&self, sid: &str) -> bool {
        self.sessions.lock().get(sid).map(|s| s.plan_mode).unwrap_or(false)
    }

    /// Replace the session's todo list and emit the authoritative
    /// `chat:plan-updated` event. Returns the normalized list.
    fn set_todos<R: tauri::Runtime>(
        &self,
        app: Option<&AppHandle<R>>,
        sid: &str,
        todos: Vec<PlanTodo>,
    ) -> Vec<PlanTodo> {
        self.sessions
            .lock()
            .entry(sid.to_string())
            .or_default()
            .todos = todos.clone();
        if let Some(app) = app {
            let _ = app.emit(
                "chat:plan-updated",
                ChatPlanUpdatedPayload {
                    chat_session_id: sid.to_string(),
                    todos: todos.clone(),
                },
            );
        }
        todos
    }

    /// Flip plan mode and emit `chat:plan-mode` when the value changed.
    /// `label` is the session's `permission_mode` value after the transition
    /// ("plan" on entry, the restored posture label on exit) — the UI's mode
    /// selector mirrors it directly.
    pub(crate) fn set_plan_mode<R: tauri::Runtime>(
        &self,
        app: Option<&AppHandle<R>>,
        sid: &str,
        active: bool,
        reason: &str,
        label: &str,
    ) -> bool {
        let changed = {
            let mut map = self.sessions.lock();
            let s = map.entry(sid.to_string()).or_default();
            if s.plan_mode == active {
                false
            } else {
                s.plan_mode = active;
                true
            }
        };
        if changed {
            if let Some(app) = app {
                let _ = app.emit(
                    "chat:plan-mode",
                    ChatPlanModePayload {
                        chat_session_id: sid.to_string(),
                        active,
                        reason: Some(reason.to_string()),
                        label: label.to_string(),
                    },
                );
            }
        }
        changed
    }

    /// Store rejection feedback for a pending plan proposal.
    pub fn store_feedback(&self, pending_id: &str, feedback: String) {
        self.feedback.lock().insert(pending_id.to_string(), feedback);
    }

    pub fn take_feedback(&self, pending_id: &str) -> Option<String> {
        self.feedback.lock().remove(pending_id)
    }

    /// Record an approved plan (newest first, capped) and emit
    /// `chat:plan-accepted` so the sidebar Plans list picks it up.
    fn record_accepted_plan<R: tauri::Runtime>(
        &self,
        app: Option<&AppHandle<R>>,
        sid: &str,
        title: String,
        content: String,
    ) -> PlanRecord {
        let id = {
            let mut n = self.next_plan_id.lock();
            let id = format!("plan-{n}");
            *n += 1;
            id
        };
        let record = PlanRecord {
            id,
            title,
            content,
            approved_at: crate::db::now_ts(),
        };
        {
            let mut map = self.plans.lock();
            let list = map.entry(sid.to_string()).or_default();
            list.insert(0, record.clone());
            list.truncate(MAX_PLANS);
        }
        if let Some(app) = app {
            let _ = app.emit(
                "chat:plan-accepted",
                ChatPlanAcceptedPayload {
                    chat_session_id: sid.to_string(),
                    plan: record.clone(),
                },
            );
        }
        record
    }

    /// Approved plans for a session (newest first).
    #[allow(dead_code)]
    pub fn plans(&self, sid: &str) -> Vec<PlanRecord> {
        self.plans.lock().get(sid).cloned().unwrap_or_default()
    }

    /// Drop every per-session entry (called on session delete).
    pub fn clear_session(&self, sid: &str) {
        self.sessions.lock().remove(sid);
        self.plans.lock().remove(sid);
    }
}

/// Parse + normalize the `items` array of a `todo_write` / `present_plan`
/// call. Tolerant by design: unknown status values coerce to `pending`,
/// missing `status` defaults to `pending`, `todos` is accepted as an alias
/// for `items` (models mix up the key), and multiple `in_progress` items
/// collapse to the first (the contract is at most one active step).
pub(crate) fn parse_todos(args: &Value) -> Result<Vec<PlanTodo>, String> {
    let items = args
        .get("items")
        .or_else(|| args.get("todos"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            "todo_write requires `items`: an array of {content, status, active_form?} objects"
                .to_string()
        })?;
    if items.len() > MAX_TODOS {
        return Err(format!(
            "Too many items ({}) — the task list is capped at {MAX_TODOS}. Split the work.",
            items.len()
        ));
    }
    let mut todos: Vec<PlanTodo> = Vec::with_capacity(items.len());
    for item in items {
        let content = item
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if content.is_empty() {
            return Err("Every item needs a non-empty `content` string.".to_string());
        }
        let status = match item.get("status").and_then(|v| v.as_str()) {
            Some("in_progress") | Some("in-progress") | Some("active") => "in_progress",
            Some("completed") | Some("done") => "completed",
            _ => "pending",
        };
        let active_form = item
            .get("active_form")
            .or_else(|| item.get("activeForm"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let content = if content.chars().count() > MAX_CONTENT_CHARS {
            crate::util::truncate_chars(&content, MAX_CONTENT_CHARS)
        } else {
            content
        };
        todos.push(PlanTodo {
            content,
            status: status.to_string(),
            active_form,
        });
    }
    if todos.is_empty() {
        return Err("`items` must contain at least one step.".to_string());
    }
    // Enforce "at most one in_progress": the first wins, the rest are demoted.
    let mut seen_active = false;
    for t in &mut todos {
        if t.status == "in_progress" {
            if seen_active {
                t.status = "pending".to_string();
            } else {
                seen_active = true;
            }
        }
    }
    Ok(todos)
}

/// The plan-mode dispatch gate: `Some(denial_text)` when a tool call must be
/// refused because the session is in plan mode. Pure so it's unit-testable;
/// `run_tool` supplies `name` and the session's plan-mode flag.
///
/// Mutating surface covered: filesystem writes/edits/deletes/moves, shell,
/// downloads, code execution, artifact generation, live-browser type/click,
/// attach meta-tools (plan mode is research-only — no session config changes),
/// and Write-kind connector/MCP vendor tools (handled in `run_tool`'s remote
/// branches, which call this same gate). Read-only surface (file
/// reads/search, browser_read/screenshot, web search/fetch, ledger tools,
/// task status/cancel, the `Task` research subagent) stays available — that's
/// the point of plan mode: research first, then propose.
pub(crate) fn gate_denial(plan_mode: bool, name: &str) -> Option<String> {
    if !plan_mode || !is_mutating_tool(name) {
        return None;
    }
    Some(format!(
        "Error: plan mode is active — `{name}` was blocked (read-only). Research the task, \
         then call `present_plan` with your step-by-step plan; the user's approval unlocks \
         changes. If it turns out no changes are needed, just answer in text."
    ))
}

/// Whether a tool name can change user-visible state. Centralized here (next
/// to `permission::is_mutating_fs_tool`, which it extends to non-FS tools) so
/// the plan gate and future callers agree on one list.
pub(crate) fn is_mutating_tool(name: &str) -> bool {
    if crate::chat::permission::is_mutating_fs_tool(name) {
        return true;
    }
    // Scheduling/deleting an automation changes persisted state (and a run
    // fires unattended), so plan mode refuses it like every other mutation.
    // The read-only list_automations stays allowed during research.
    if crate::chat::tools::is_mutating_automation_tool(name) {
        return true;
    }
    matches!(
        name,
        "run_shell" | "shell" | "RunShell"
            | "download_file" | "download"
            | "run_code"
            | "generate_file" | "generate_document" | "generate_diagram"
            | "browser_type" | "browser_click"
            | "attach_connector" | "attach_mcp_server"
    )
}

/// Whether `name` is one of the three plan tools (never gated; dispatched here).
pub(crate) fn is_plan_tool(name: &str) -> bool {
    matches!(name, TODO_WRITE | ENTER_PLAN_MODE | PRESENT_PLAN)
}

/// Persist plan mode on the session row: the legacy `permission_mode` column
/// stores "plan" while active and the posture label derived from the untouched
/// dual policies on exit. Returns the label now stored. Best-effort — a DB
/// failure never blocks the turn (the in-memory gate stays authoritative for
/// the live session).
fn persist_plan_mode<R: tauri::Runtime>(app: &AppHandle<R>, sid: &str, active: bool) -> String {
    use tauri::Manager;
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    crate::db::set_chat_session_plan(&conn, sid, active).unwrap_or_else(|_| {
        if active {
            "plan".to_string()
        } else {
            "manual".to_string()
        }
    })
}

/// Dispatch a plan tool call. Returns `Some(result_text)` when `name` was a
/// plan tool (the caller must not run it anywhere else), `None` otherwise.
pub(crate) async fn run_plan_tool(
    plan: &PlanState,
    mgr: &std::sync::Arc<crate::chat::ChatManager>,
    app: &AppHandle,
    sid: &str,
    name: &str,
    args: &Value,
) -> Option<String> {
    match name {
        TODO_WRITE => Some(handle_todo_write(plan, app, sid, args)),
        ENTER_PLAN_MODE => Some(handle_enter_plan_mode(plan, app, sid, args)),
        PRESENT_PLAN => Some(handle_present_plan(plan, mgr, app, sid, args).await),
        _ => None,
    }
}

fn handle_todo_write(plan: &PlanState, app: &AppHandle, sid: &str, args: &Value) -> String {
    match parse_todos(args) {
        Ok(todos) => {
            let active = todos.iter().filter(|t| t.status == "in_progress").count();
            let done = todos.iter().filter(|t| t.status == "completed").count();
            plan.set_todos(Some(app), sid, todos);
            format!("Todo list updated ({done} completed, {active} in progress). Keep it current: mark steps completed as you finish them, at most one in_progress.")
        }
        Err(e) => format!("Error: {e}"),
    }
}

fn handle_enter_plan_mode(plan: &PlanState, app: &AppHandle, sid: &str, args: &Value) -> String {
    let reason = args
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("model requested planning")
        .trim()
        .to_string();
    let changed = plan.plan_mode(sid);
    if !changed {
        // Persist FIRST so the emitted event's label matches the stored row.
        let label = persist_plan_mode(app, sid, true);
        plan.set_plan_mode(Some(app), sid, true, &reason, &label);
        "Plan mode is active. From here: research the task with read-only tools \
         (read_file, list_directory, search_*, web_search, browser_read), then call \
         `present_plan` with the full step list. Mutating tools are blocked until the user \
         approves the plan. If the task turns out to need no changes, simply answer in text \
         (the user can also switch the mode off)."
            .to_string()
    } else {
        "Plan mode is already active. Research read-only, then call `present_plan` with your \
         plan when ready."
            .to_string()
    }
}

/// Repair plan markdown that models sometimes mangle in tool-call JSON:
/// literal `\n` escape sequences instead of real newlines, and block markers
/// (headings) emitted inline on one long line. Without this the approval card
/// and the Plans canvas render one unreadable paragraph of raw `###`/`**`.
fn normalize_plan_markdown(input: &str) -> String {
    // 1. Literal escape sequences → real newlines.
    let unescaped = input
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace('\r', "\n");
    // 2. A heading marker that is NOT at line start starts a new block
    //    ("text ## Heading" → break). Line-start headings are untouched.
    let headings = regex::Regex::new(r"([^\n])[ \t]+(#{1,6}[ \t]+\S)").unwrap();
    let broken_out = headings.replace_all(&unescaped, "${1}\n\n${2}");
    // 3. Collapse runaway blank lines.
    let blanks = regex::Regex::new(r"\n{3,}").unwrap();
    blanks.replace_all(&broken_out, "\n\n").to_string()
}

/// Parse the `plan` markdown argument of `present_plan`. Returns
/// (title, content) — the title falls back to the first markdown heading or
/// the first line, truncated for card/list display.
pub(crate) fn parse_plan_text(args: &Value) -> Result<(String, String), String> {
    let raw = args
        .get("plan")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if raw.is_empty() {
        return Err(
            "present_plan requires `plan`: the detailed approach as markdown.".to_string(),
        );
    }
    let plan = normalize_plan_markdown(&raw);
    if plan.chars().count() > MAX_PLAN_CHARS {
        return Err(format!(
            "Plan too long ({plan} > {MAX_PLAN_CHARS} chars) — summarize the approach."
        ));
    }
    let arg_title = args
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let derived = plan
        .lines()
        .find(|l| !l.trim().is_empty())
        .map(|l| {
            l.trim()
                .trim_start_matches('#')
                .trim()
                .to_string()
        })
        .unwrap_or_else(|| "Plan".to_string());
    let title = arg_title.unwrap_or(derived);
    let title = if title.chars().count() > 80 {
        crate::util::truncate_chars(&title, 80)
    } else {
        title
    };
    Ok((title, plan))
}

/// The plan-then-steps sequence handler. `present_plan` is ONLY meaningful in
/// plan mode — outside it a model that calls it after already doing work gets
/// an error steering it back (that's exactly the "wrote files, then proposed
/// a plan" misuse).
async fn handle_present_plan(
    plan: &PlanState,
    mgr: &std::sync::Arc<crate::chat::ChatManager>,
    app: &AppHandle,
    sid: &str,
    args: &Value,
) -> String {
    if !plan.plan_mode(sid) {
        return "Error: `present_plan` is only available in plan mode — it exists so the user \
             approves an approach BEFORE any changes are made. You are not in plan mode: do \
             the work directly and track progress with `todo_write`. If the user should \
             approve the approach first, call `enter_plan_mode`."
            .to_string();
    }
    let (title, plan_text) = match parse_plan_text(args) {
        Ok(t) => t,
        Err(e) => return format!("Error: {e}"),
    };
    let summary = format!("Plan proposal: {title}");
    let (pending_id, rx) =
        mgr.register_pending_approval(sid, PRESENT_PLAN, args.clone(), summary);
    let _ = app.emit(
        "chat:plan-proposal",
        ChatPlanProposalPayload {
            chat_session_id: sid.to_string(),
            pending_id: pending_id.clone(),
            title: title.clone(),
            plan: plan_text.clone(),
        },
    );
    match rx.await {
        Ok(true) => {
            // Approved: record it for the sidebar Plans list and exit plan
            // mode (the preserved dual policies resume — mutations unlock).
            plan.record_accepted_plan(Some(app), sid, title, plan_text);
            let label = persist_plan_mode(app, sid, false);
            plan.set_plan_mode(Some(app), sid, false, "plan approved", &label);
            "Plan approved and recorded. Now: (1) break the plan into concrete \
             steps with `todo_write` — at most one in_progress, mark steps completed \
             immediately after finishing them; (2) execute, keeping the list current as \
             you work."
                .to_string()
        }
        Ok(false) => {
            let feedback = plan
                .take_feedback(&pending_id)
                .unwrap_or_else(|| "(no feedback given)".to_string());
            format!(
                "User rejected the plan. Their feedback: {feedback}\n\
                 Revise the plan and call `present_plan` again — or, if no file/shell changes \
                 are actually needed, simply answer in text."
            )
        }
        Err(_) => {
            // The stream was cancelled / session torn down — senders drop and
            // the receiver errors, mirroring gated-tool denial semantics.
            plan.take_feedback(&pending_id);
            "Plan proposal cancelled (the turn was aborted).".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- parse_todos ----

    #[test]
    fn parse_todos_happy_path() {
        let todos = parse_todos(&json!({ "items": [
            {"content": "Read the config", "status": "completed"},
            {"content": "Write parser", "status": "in_progress", "active_form": "Writing parser"},
            {"content": "Wire up CLI", "status": "pending"},
        ]}))
        .unwrap();
        assert_eq!(todos.len(), 3);
        assert_eq!(todos[0].status, "completed");
        assert_eq!(todos[1].status, "in_progress");
        assert_eq!(todos[1].active_form.as_deref(), Some("Writing parser"));
        assert_eq!(todos[2].status, "pending");
    }

    #[test]
    fn parse_todos_accepts_todos_alias_and_missing_status() {
        let todos = parse_todos(&json!({ "todos": [
            {"content": "One"}, {"content": "Two", "status": "done"},
        ]}))
        .unwrap();
        assert_eq!(todos[0].status, "pending");
        assert_eq!(todos[1].status, "completed");
    }

    #[test]
    fn parse_todos_coerces_unknown_status_and_multiple_in_progress() {
        let todos = parse_todos(&json!({ "items": [
            {"content": "A", "status": "running"},
            {"content": "B", "status": "in_progress"},
            {"content": "C", "status": "in_progress"},
        ]}))
        .unwrap();
        // Unknown -> pending; only the FIRST in_progress survives.
        assert_eq!(todos[0].status, "pending");
        assert_eq!(todos[1].status, "in_progress");
        assert_eq!(todos[2].status, "pending");
    }

    #[test]
    fn parse_todos_rejects_empty_content_and_missing_items() {
        assert!(parse_todos(&json!({ "items": [{"content": "  "}]})).is_err());
        assert!(parse_todos(&json!({})).is_err());
        assert!(parse_todos(&json!({"items": []})).is_err());
        assert!(parse_todos(&json!({"items": "nope"})).is_err());
    }

    #[test]
    fn parse_todos_caps_list_size() {
        let items: Vec<Value> = (0..60)
            .map(|i| json!({"content": format!("step {i}")}))
            .collect();
        let err = parse_todos(&json!({ "items": items })).unwrap_err();
        assert!(err.contains("capped at 50"), "{err}");
    }

    // ---- gate ----

    #[test]
    fn gate_blocks_mutating_tools_in_plan_mode() {
        for name in [
            "write_file", "edit_file", "delete_file", "move_file", "copy_file",
            "run_shell", "download_file", "run_code",
            "generate_file", "generate_document", "generate_diagram",
            "browser_type", "browser_click",
        ] {
            let denial = gate_denial(true, name);
            assert!(denial.is_some(), "{name} must be blocked in plan mode");
            assert!(denial.unwrap().contains("present_plan"));
        }
    }

    #[test]
    fn gate_allows_reads_and_is_off_outside_plan_mode() {
        for name in [
            "read_file", "list_directory", "search_files", "search_content",
            "web_search", "fetch_url", "browser_read", "browser_screenshot",
            "get_task_status", "cancel_task", "Task", "add_source_note",
        ] {
            assert!(gate_denial(true, name).is_none(), "{name} must stay allowed");
        }
        // Gate inert when plan mode is off — even for mutating tools.
        assert!(gate_denial(false, "write_file").is_none());
        assert!(gate_denial(false, "run_shell").is_none());
    }

    #[test]
    fn plan_tools_never_self_gate() {
        // is_mutating_tool must not classify the plan tools, so the gate can
        // never refuse them.
        assert!(!is_plan_tool("write_file"));
        for name in [TODO_WRITE, ENTER_PLAN_MODE, PRESENT_PLAN] {
            assert!(is_plan_tool(name));
            assert!(!is_mutating_tool(name), "{name} must not be mutating");
        }
    }

    // ---- present_plan text ----

    #[test]
    fn parse_plan_text_happy_path_and_title_fallback() {
        // Explicit title wins.
        let (title, content) = parse_plan_text(&json!({
            "title": "Auth refactor",
            "plan": "## Approach\nSplit the auth module and add tests."
        }))
        .unwrap();
        assert_eq!(title, "Auth refactor");
        assert!(content.contains("## Approach"));

        // No title → first heading, stripped of marks.
        let (title, _) = parse_plan_text(&json!({
            "plan": "## Rewrite the parser\nDetails here."
        }))
        .unwrap();
        assert_eq!(title, "Rewrite the parser");

        // No heading → first non-empty line.
        let (title, _) = parse_plan_text(&json!({ "plan": "Just do it in one pass.\nMore." }))
            .unwrap();
        assert_eq!(title, "Just do it in one pass.");
    }

    #[test]
    fn parse_plan_text_rejects_empty_and_overlong() {
        assert!(parse_plan_text(&json!({})).is_err());
        assert!(parse_plan_text(&json!({ "plan": "   " })).is_err());
        let big = "x".repeat(MAX_PLAN_CHARS + 1);
        assert!(parse_plan_text(&json!({ "plan": big })).is_err());
    }

    #[test]
    fn parse_plan_text_normalizes_mangled_markdown() {
        // Literal \n escapes → real newlines.
        let (_, body) = parse_plan_text(&json!({
            "plan": "## A\\n- one\\n- two"
        }))
        .unwrap();
        assert!(body.contains("## A\n- one"), "{body}");

        // Inline heading marker → broken out onto its own block.
        let (_, body) = parse_plan_text(&json!({
            "plan": "Intro line. ## Heading one **Bold** stays inline. ## Heading two"
        }))
        .unwrap();
        assert!(body.contains("\n\n## Heading one"), "{body}");
        assert!(body.contains("\n\n## Heading two"), "{body}");
        // Already-multiline markdown passes through without extra breaks.
        let (_, body) = parse_plan_text(&json!({ "plan": "## Top\nBody text.\n" }))
            .unwrap();
        assert_eq!(body, "## Top\nBody text.");
    }

    #[test]
    fn accepted_plans_record_newest_first_and_cap() {
        let state = PlanState::default();
        for i in 0..(MAX_PLANS + 3) {
            state.record_accepted_plan(
                Option::<&AppHandle>::None,
                "s1",
                format!("plan {i}"),
                "content".into(),
            );
        }
        let plans = state.plans("s1");
        assert_eq!(plans.len(), MAX_PLANS);
        assert_eq!(plans[0].title, format!("plan {}", MAX_PLANS + 2));
        // Other sessions unaffected; clear_session drops everything.
        assert!(state.plans("s2").is_empty());
        state.clear_session("s1");
        assert!(state.plans("s1").is_empty());
    }

    // ---- state transitions ----

    #[test]
    fn plan_state_roundtrip() {
        let state = PlanState::default();
        assert!(!state.plan_mode("s1"));
        assert!(state.todos("s1").is_empty());

        let todos = parse_todos(&json!({ "items": [{"content": "A"}] })).unwrap();
        state.set_todos(Option::<&AppHandle>::None, "s1", todos.clone());
        assert_eq!(state.todos("s1"), todos);
        // Other sessions unaffected.
        assert!(state.todos("s2").is_empty());

        assert!(state.set_plan_mode(Option::<&AppHandle>::None, "s1", true, "test", "plan"));
        assert!(state.plan_mode("s1"));
        // No change on re-set — no duplicate events.
        assert!(!state.set_plan_mode(Option::<&AppHandle>::None, "s1", true, "test", "plan"));
        assert!(state.set_plan_mode(Option::<&AppHandle>::None, "s1", false, "test", "manual"));

        state.clear_session("s1");
        assert!(state.todos("s1").is_empty());
        assert!(!state.plan_mode("s1"));
    }

    #[test]
    fn feedback_store_then_take() {
        let state = PlanState::default();
        state.store_feedback("p1", "too broad".into());
        assert_eq!(state.take_feedback("p1").as_deref(), Some("too broad"));
        assert!(state.take_feedback("p1").is_none());
    }
}
