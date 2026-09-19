//! App-side half of the `relay-tools` MCP server. The relay binary forwards
//! `tools/call` for generate_document / plan_document / revise_document /
//! generate_diagram / generate_file / get_skill / list_skills / search_docs /
//! the automation CRUD family over the loopback WebSocket; this
//! module runs them through the SAME `chat::tools::execute_tool` dispatcher
//! the built-in chat uses, so the harness gets the identical output pipeline
//! and artifact classification. Generated files land in the shared artifacts
//! dir, where the session's DirWatch post-turn diff surfaces them as artifact
//! chips.

use serde_json::{json, Value};
use tauri::Manager;
use crate::browser_mcp::McpError;
use crate::chat::tools::{self, ToolCaps};

/// The only chat tools the `relay-tools` MCP server ADVERTISES and may
/// invoke. THE classification list: when you add a tool, the
/// `every_registry_tool_is_bridged_or_excluded` test in `chat::tools::tests`
/// fails until the new tool appears here (or in `BRIDGE_EXCLUDED_TOOLS` with
/// a reason) — this is what stops "forgot to add it to the harness" bugs.
/// The WS server must not rely on the relay binary's own `tool_op` whitelist
/// for authorization: any local process holding the auth token could
/// otherwise reach mutating tools (write_file/delete_file/run_shell/…) with
/// no permission-mode gate, since this path intentionally runs the same
/// ungated dispatcher the built-in chat uses (where the caller enforces the
/// gate BEFORE reaching execute_tool).
pub const ALLOWED_RELAY_TOOLS: [&str; 21] = [
    tools::GENERATE_DOCUMENT,
    tools::GENERATE_IMAGE,
    tools::PLAN_DOCUMENT,
    tools::REVISE_DOCUMENT,
    tools::GENERATE_DIAGRAM,
    tools::GENERATE_FILE,
    tools::GET_SKILL,
    tools::LIST_SKILLS,
    tools::SEARCH_DOCS,
    tools::GET_CAPABILITIES,
    tools::LIST_ARTIFACTS,
    tools::LIST_AUTOMATIONS,
    tools::CREATE_AUTOMATION,
    tools::UPDATE_AUTOMATION,
    tools::DELETE_AUTOMATION,
    tools::RUN_AUTOMATION_NOW,
    tools::LIST_SESSIONS,
    tools::READ_SESSION,
    tools::SEARCH_SESSIONS,
    tools::MESSAGE_SESSION,
    tools::SPAWN_SESSION,
];

/// Strip the `relay_tools:` prefix from a WS op; None for non-tool ops and
/// for any tool outside the relay whitelist (those fall through to
/// `unknown_op` in the dispatcher).
/// MCP tool schemas for every bridged tool, DERIVED from the live tool
/// registry — the relay sidecar fetches this over the WS (`relay_schemas` op)
/// for its `tools/list`, so a new tool needs only: registry const + spec +
/// dispatch arm + an entry in [`ALLOWED_RELAY_TOOLS`]. No hand-written schema
/// copy in the sidecar to forget. An allowlist entry without a registry spec
/// (typo, renamed tool) is skipped here and caught by the
/// `bridge_allowlist_matches_registry` test.
pub fn relay_tool_schemas() -> Vec<Value> {
    // local_docs: `search_docs` is capability-gated in the registry but is
    // bridged unconditionally (it self-guards at runtime when the embedding
    // sidecar is down).
    let caps = ToolCaps {
        local_docs: true,
        ..ToolCaps::default()
    };
    let all = tools::openai_tool_specs(&caps, crate::chat::permission::SandboxPolicy::WorkspaceWrite);
    ALLOWED_RELAY_TOOLS
        .iter()
        .filter_map(|name| {
            all.iter()
                .find(|s| s.pointer("/function/name").and_then(|n| n.as_str()) == Some(*name))
                .map(|s| {
                    json!({
                        "name": s["function"]["name"],
                        "description": s["function"]["description"],
                        "inputSchema": s["function"]["parameters"],
                    })
                })
        })
        .collect()
}

pub fn tool_from_op(op: &str) -> Option<String> {
    let rest = op.strip_prefix("relay_tools:")?;
    if ALLOWED_RELAY_TOOLS.contains(&rest) { Some(rest.to_string()) } else { None }
}

pub fn outcome_text(o: &tools::ToolOutcome) -> &str {
    &o.text
}

pub fn outcome_artifact_json(o: &tools::ToolOutcome) -> Value {
    match &o.artifact {
        Some(a) => json!({ "filename": a.filename, "path": a.path }),
        None => Value::Null,
    }
}

/// Execute one relay-tools call and return the text result + artifact info.
pub async fn execute_relay_tool(
    app: &tauri::AppHandle,
    tool_name: &str,
    args: &Value,
) -> Result<Value, McpError> {
    // The availability report is app-level on this path (no per-turn
    // attachment state exists for a harness CLI) — build it directly instead
    // of the ToolCaps-driven report execute_tool would produce.
    if tool_name == tools::GET_CAPABILITIES {
        let text = tools::app_capabilities_report(app).await;
        return Ok(json!({ "text": text, "artifact": Value::Null }));
    }
    // The automation family dispatches through its own handler (AppHandle →
    // DbState) — the same split dispatch.rs uses for the built-in chat; the
    // provider-agnostic execute_tool doesn't route it. Tool results are text.
    //
    // TRUST GATE (audit HIGH-1): the built-in chat only reaches
    // execute_automation_tool after dispatch.rs showed the user an explicit
    // approval card for the call; THIS relay path is ungated, and every run
    // forces full-auto — an unconfirmed automation would execute whatever a
    // harness scheduled, unattended. The gate defers confirmation to the
    // EXISTING surface (the Automations view's enable toggle) instead of
    // duplicating approval UI: relay-created rows start disabled, relay
    // updates may not enable, and run-now refuses disabled rows. See
    // `gate_relay_automation_op`.
    if tools::is_automation_tool(tool_name) {
        let text = match gate_relay_automation_op(app, tool_name, args).await {
            // Err = final refusal text — the underlying tool call is skipped.
            Err(text) => text,
            Ok((args, note)) => {
                let mut text = tools::execute_automation_tool(app, tool_name, &args).await;
                if let Some(note) = note {
                    text.push_str(note);
                }
                text
            }
        };
        return Ok(json!({ "text": text, "artifact": Value::Null }));
    }
    // Session Mesh family: same interception shape. `execute_mesh_tool`
    // carries the caller identity in args (`session_id` — the registry block
    // injected at spawn states it), because this path has no built-in notion
    // of which chat is calling.
    if tools::is_mesh_tool(tool_name) {
        let text = crate::session_fabric::execute_mesh_tool(app, None, tool_name, args).await;
        return Ok(json!({ "text": text, "artifact": Value::Null }));
    }
    // Same client construction the built-in chat uses (chat/mod.rs).
    // Image generation is LONG (minutes — model load + 20+ diffusion steps,
    // serialized server-side). Harness MCP clients impose their own tool-call
    // timeouts no local diffusion run can reliably fit, so over the bridge
    // this tool returns IMMEDIATELY and the render continues app-side; the
    // PNG lands at the exact path cited in the reply (the session's
    // post-turn DirWatch surfaces it as an artifact chip).
    if tool_name == tools::GENERATE_IMAGE {
        return Ok(generate_image_background(app, args));
    }
    let client = reqwest::Client::new();
    let artifacts_dir = crate::chat::dispatch::artifacts_dir(app);
    let caps = ToolCaps::default();
    let outcome = tools::execute_tool(&client, &artifacts_dir, &caps, tool_name, args, Some(app)).await;
    Ok(json!({
        "text": outcome_text(&outcome),
        "artifact": outcome_artifact_json(&outcome)
    }))
}

/// Fire-and-forget image generation for the bridge: validate, cite the exact
/// output path, and keep rendering after the tool call has returned.
fn generate_image_background(app: &tauri::AppHandle, args: &Value) -> Value {
    let prompt = args
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if prompt.is_empty() {
        return json!({
            "text": "Error: generate_image requires a non-empty \"prompt\".",
            "artifact": Value::Null
        });
    }
    // Size: the agent MAY pass width/height; omitted = 0 sentinel → the
    // engine renders at the ACTIVE MODEL's native size (512-class checkpoints
    // stay sharp, SDXL-class at 1024) instead of a global default.
    let width = args.get("width").and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(0);
    let height = args.get("height").and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(0);
    // Small-VRAM guard: a 1024px request on a ~6GB card graph-cuts to RAM and
    // runs 5-15 minutes (or crashes the renderer mid-flight, leaving the
    // model polling a file that never appears).
    let small_gpu = crate::chat::local_models::query_free_vram_bytes()
        .map(|v| v < 6 * 1024 * 1024 * 1024)
        .unwrap_or(true);
    let max_dim: u32 = if small_gpu { 768 } else { 2048 };
    let clamped = (width, height) != (width.min(max_dim), height.min(max_dim));
    let width = width.min(max_dim);
    let height = height.min(max_dim);
    // Save OUTSIDE any session worktree: harness turns checkpoint the
    // project tree and the post-turn restore DELETES files created during
    // the turn (verified — a finished render vanished this way). The
    // app-data generated dir is never checkpointed.
    let save_dir = crate::user_dirs::app_data_dir(app).join("generated-images");
    let _ = std::fs::create_dir_all(&save_dir);
    let started_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let filename = format!("image-{started_secs}.png");
    let out_path = save_dir.join(&filename);
    let out_path_display = out_path.display().to_string();
    let out_path_display_clone = out_path_display.clone();

    // In-flight dedupe: harness MCP clients retry on their own timeouts, and
    // each retry used to spawn a SECOND full render for the same prompt.
    // Same prompt within the dedupe window → return the existing render's
    // path instead of starting another one.
    static INFLIGHT: std::sync::LazyLock<
        std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, String)>>,
    > = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    {
        let mut map = INFLIGHT.lock().unwrap();
        let key = format!("{}|{}x{}", prompt.trim().to_lowercase(), width, height);
        map.retain(|_, (t, _)| t.elapsed() < std::time::Duration::from_secs(600));
        if let Some((_, existing)) = map.get(&key) {
            return json!({
                "text": format!(
                    "A render for this exact prompt is ALREADY in progress — its PNG will be saved to \"{}\" when done. Do NOT call generate_image again; the user sees live progress in the UI.",
                    existing
                ),
                "artifact": Value::Null
            });
        }
        map.insert(key, (std::time::Instant::now(), out_path_display.clone()));
    }

    let app = app.clone();
    crate::commands::image_gen::emit_update(
        &app,
        "starting",
        json!({ "width": width, "height": height, "path": out_path_display }),
    );
    tauri::async_runtime::spawn(async move {
        // out_path makes the ONE done event (emitted inside generate_via_app)
        // carry the final file path — no rename afterward, no second event.
        let result = crate::commands::image_gen::generate_via_app(
            &app,
            &prompt,
            width,
            height,
            Some(&save_dir),
            Some(&out_path),
        )
        .await;
        match result {
            Ok(img) => {
                // Register in the Artifacts gallery (global listing — harness
                // sessions have no chat_session_id, so insert unowned).
                {
                    let db = app.state::<crate::DbState>();
                    let conn = db.0.lock();
                    let _ = crate::db::insert_artifact(
                        &conn,
                        None,
                        &filename,
                        &out_path_display_clone,
                        "png",
                    );
                }
                eprintln!(
                    "[image-gen] background render done: {}",
                    img.path.unwrap_or_else(|| out_path.display().to_string())
                );
            }
            Err(e) => {
                // generate_via_app already emitted the error event.
                eprintln!("[image-gen] background render failed: {e}");
            }
        }
    });

    json!({
        "text": format!(
            "Image generation STARTED in the background (local diffusion, {}x{}{}). The PNG will              be saved to \"{}\" — typically 1-5 minutes on a GPU, up to 20 on CPU. Relay's UI              shows live progress to the user, so do NOT poll with shell/sleep tools and do NOT              call generate_image again for the same prompt. When the user asks about it, reference              the exact path above (confirm it exists first).{}",
            width,
            height,
            if clamped { format!(" — requested size clamped: this GPU cannot handle larger renders") } else { String::new() },
            out_path_display,
            String::new()
        ),
        "artifact": Value::Null
    })
}

/// One-time-user-confirmation gate for automations created or fired through
/// the relay bridge (audit HIGH-1). The BUILT-IN chat reaches
/// `execute_automation_tool` only after an explicit user approval card for the
/// call (dispatch.rs); this relay path has no such gate, and automation runs
/// force full-auto permission (see automations.rs — unattended turns can't
/// answer prompts). A full in-bridge confirmation loop would need frontend
/// changes, so the gate reuses the confirmation surface that already exists:
/// the Automations view's enable toggle. The user flipping the row on IS the
/// one-time confirmation; enabled rows (user-created or chat-approved) behave
/// exactly as before.
///
/// Rules:
/// 1. `create_automation` is forced to `enabled:false` — the caller's value
///    is discarded — and an `automation:approval-request` event is emitted
///    (same lifecycle-event shape the scheduler uses) so the UI/log can
///    surface the pending row. The scheduler's due-math skips disabled rows,
///    so nothing runs until a human enables it.
/// 2. `update_automation` may not enable: an `enabled:true` argument is
///    DROPPED (not flipped to false — an update must never disable a
///    user-enabled row either) and a note is appended, so the agent can't
///    confirm itself.
/// 3. `run_automation_now` refuses while the row is disabled — without this,
///    "create disabled, fire immediately" would bypass rule 1 entirely.
///
/// Returns the (possibly rewritten) args plus an optional note to append to
/// the tool's response text, or `Err(final_text)` when the call is refused
/// outright (the underlying tool must NOT run).
async fn gate_relay_automation_op(
    app: &tauri::AppHandle,
    tool_name: &str,
    args: &Value,
) -> Result<(Value, Option<&'static str>), String> {
    use tauri::{Emitter, Manager};

    if tool_name == tools::CREATE_AUTOMATION {
        let mut gated = args.clone();
        if let Some(obj) = gated.as_object_mut() {
            obj.insert("enabled".into(), Value::Bool(false));
        }
        // Best-effort visibility hook: the row exists but waits on a human.
        let _ = app.emit(
            "automation:approval-request",
            json!({
                "source": "relay_bridge",
                "name": args.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "schedule": args.get("schedule").and_then(|v| v.as_str()).unwrap_or(""),
                "harness": args.get("agent").and_then(|v| v.as_str()).unwrap_or("claude_code"),
            }),
        );
        Ok((gated, None))
    } else if tool_name == tools::UPDATE_AUTOMATION
        && args.get("enabled").and_then(|v| v.as_bool()) == Some(true)
    {
        // Drop the key entirely so the stored `enabled` state is untouched.
        let mut gated = args.clone();
        if let Some(obj) = gated.as_object_mut() {
            obj.remove("enabled");
        }
        Ok((
            gated,
            Some(
                " NOTE: the enabled:true request was ignored — automations can only \
                 be enabled by the user in the Automations view.",
            ),
        ))
    } else if tool_name == tools::RUN_AUTOMATION_NOW {
        let id = args.get("automation_id").and_then(|v| v.as_str()).unwrap_or("");
        let enabled = {
            let db = app.state::<crate::DbState>();
            let conn = db.0.lock();
            crate::db::get_automation(&conn, id)
                .ok()
                .flatten()
                .map(|a| a.enabled)
        };
        match enabled {
            // Enabled (user-confirmed) rows — and unknown ids, which the tool
            // itself reports — run through the normal path.
            Some(true) | None => Ok((args.clone(), None)),
            Some(false) => Err(format!(
                "Error: automation \"{id}\" is disabled and was NOT run — \
                 the user must enable it in the Automations view first."
            )),
        }
    } else {
        Ok((args.clone(), None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_name_extraction() {
        assert_eq!(tool_from_op("relay_tools:generate_document"), Some("generate_document".to_string()));
        assert_eq!(tool_from_op("relay_tools:search_docs"), Some("search_docs".to_string()));
        // Read-only introspection is allowed through the relay.
        assert_eq!(tool_from_op("relay_tools:get_capabilities"), Some("get_capabilities".to_string()));
        // The plan-compiled design path is reachable from harnesses (same
        // artifacts-dir-only risk class as generate_document).
        assert_eq!(tool_from_op("relay_tools:plan_document"), Some("plan_document".to_string()));
        assert_eq!(tool_from_op("relay_tools:revise_document"), Some("revise_document".to_string()));
        // Automation CRUD is offered to harness sessions (built-in-chat parity).
        assert_eq!(tool_from_op("relay_tools:list_automations"), Some("list_automations".to_string()));
        assert_eq!(tool_from_op("relay_tools:create_automation"), Some("create_automation".to_string()));
        assert_eq!(tool_from_op("relay_tools:update_automation"), Some("update_automation".to_string()));
        assert_eq!(tool_from_op("relay_tools:delete_automation"), Some("delete_automation".to_string()));
        assert_eq!(tool_from_op("relay_tools:run_automation_now"), Some("run_automation_now".to_string()));
        // Session Mesh family reaches harness CLIs through the same bridge —
        // the read trio and the write pair alike (the write pair's approval
        // gate lives in the built-in path's run_tool; over the bridge the
        // mesh's own caps + UI visibility are the guard, per the module doc).
        assert_eq!(tool_from_op("relay_tools:list_sessions"), Some("list_sessions".to_string()));
        assert_eq!(tool_from_op("relay_tools:read_session"), Some("read_session".to_string()));
        assert_eq!(tool_from_op("relay_tools:search_sessions"), Some("search_sessions".to_string()));
        assert_eq!(tool_from_op("relay_tools:message_session"), Some("message_session".to_string()));
        assert_eq!(tool_from_op("relay_tools:spawn_session"), Some("spawn_session".to_string()));
        assert_eq!(tool_from_op("navigate"), None);
        assert_eq!(tool_from_op("relay_tools:"), None);
        // Mutating/dangerous chat tools must be rejected server-side even
        // though they exist in chat::tools (no permission gate on this path).
        assert_eq!(tool_from_op("relay_tools:delete_file"), None);
        assert_eq!(tool_from_op("relay_tools:write_file"), None);
        assert_eq!(tool_from_op("relay_tools:run_shell"), None);
    }

    #[test]
    fn outcome_text_fallbacks() {
        // ToolOutcome::text → { text, artifact: null }
        // (ToolOutcome's `text` constructor is private to chat::tools, so we
        // build the outcome via a struct literal — all fields are pub.)
        let o = crate::chat::tools::ToolOutcome {
            text: "hello".to_string(),
            artifact: None,
            browse_url: None,
            preview: None,
        };
        assert_eq!(outcome_text(&o), "hello");
        assert!(outcome_artifact_json(&o).is_null());
    }

    /// Tools that deliberately do NOT cross the relay-tools bridge, with the
    /// reason. Together with [`ALLOWED_RELAY_TOOLS`] this is the COMPLETE
    /// classification of the tool registry for harness sessions; the
    /// exhaustive test below fails when a new tool lands in neither list.
    const BRIDGE_EXCLUDED_TOOLS: &[(&str, &str)] = &[
        // Harness CLIs have their own web search / shell / code execution —
        // Relay's pipeline for these is built-in-chat-specific.
        ("web_search", "harness CLIs search the web natively"),
        ("fetch_url", "harness CLIs fetch pages natively"),
        ("run_shell", "harness has its own shell — Relay's ungated shell must not be bridge-reachable"),
        ("run_code", "harness runs code with its own runtime"),
        ("download_file", "Relay background-task engine is built-in-chat-only; harness downloads via its own shell"),
        ("get_task_status", "Relay background-task engine is built-in-chat-only"),
        ("cancel_task", "Relay background-task engine is built-in-chat-only"),
        ("Task", "harness has its own subagent Task tool"),
        // Plan tracking drives the built-in chat's plan-mode UI state.
        ("todo_write", "plan tracking is a built-in-chat UI surface"),
        ("enter_plan_mode", "plan tracking is a built-in-chat UI surface"),
        ("present_plan", "plan tracking is a built-in-chat UI surface"),
        // Harnesses declare MCP/connector config at spawn; per-turn attach is
        // a built-in-chat concept.
        ("attach_connector", "harness declares connectors in its own MCP config at spawn"),
        ("attach_mcp_server", "harness declares MCP servers in its own MCP config at spawn"),
        // The memory core is injected into harness bundles as prose; writes
        // flow through the built-in chat.
        ("memory_save", "harness sessions get the memory core via the bundle prompt"),
        ("memory_recall", "harness sessions get the memory core via the bundle prompt"),
        ("memory_forget", "harness sessions get the memory core via the bundle prompt"),
        // The research source ledger feeds the built-in chat's Synthesis flow.
        ("add_source_note", "research ledger is the built-in chat's synthesis flow"),
        ("get_source_ledger", "research ledger is the built-in chat's synthesis flow"),
        ("reset_source_ledger", "research ledger is the built-in chat's synthesis flow"),
        ("check_sufficiency", "research ledger is the built-in chat's synthesis flow"),
        // Harnesses drive the relay-browser MCP server's own (richer, stateful)
        // browser family instead of the per-turn built-in one.
        ("browser_read", "harness uses the relay-browser MCP browser family"),
        ("browser_click", "harness uses the relay-browser MCP browser family"),
        ("browser_type", "harness uses the relay-browser MCP browser family"),
        ("browser_scroll", "harness uses the relay-browser MCP browser family"),
        ("browser_screenshot", "harness uses the relay-browser MCP browser family"),
        ("browser_observe", "harness uses the relay-browser MCP browser family"),
        ("browser_extract", "harness uses the relay-browser MCP browser family"),
        // FS tools are sandboxed per-turn (fs_roots) in the built-in chat; the
        // bridge path is ungated, so exposing them would bypass permissions.
        // Harnesses read/write the project with their own FS tools.
        ("read_file", "bridge path is permission-ungated — FS tools stay built-in"),
        ("write_file", "bridge path is permission-ungated — FS tools stay built-in"),
        ("edit_file", "bridge path is permission-ungated — FS tools stay built-in"),
        ("delete_file", "bridge path is permission-ungated — FS tools stay built-in"),
        ("copy_file", "bridge path is permission-ungated — FS tools stay built-in"),
        ("move_file", "bridge path is permission-ungated — FS tools stay built-in"),
        ("list_directory", "bridge path is permission-ungated — FS tools stay built-in"),
        ("search_files", "bridge path is permission-ungated — FS tools stay built-in"),
        ("search_content", "bridge path is permission-ungated — FS tools stay built-in"),
        // 2FA codes must only flow through the gated built-in path.
        ("totp_code", "secrets surface — bridge path is permission-ungated"),
        // OS-open UX is bound to the app window; harnesses open files themselves.
        ("open_url", "built-in browser pane / OS-open is app-window bound"),
        ("open_file", "built-in browser pane / OS-open is app-window bound"),
    ];

    #[test]
    fn bridge_allowlist_matches_registry() {
        // Every allowlist entry must resolve to a live registry spec — a typo
        // or a renamed tool would otherwise silently vanish from harnesses.
        let caps = ToolCaps {
            local_docs: true,
            ..Default::default()
        };
        let all = tools::openai_tool_specs(&caps, crate::chat::permission::SandboxPolicy::WorkspaceWrite);
        let names: Vec<&str> = all
            .iter()
            .filter_map(|s| s.pointer("/function/name").and_then(|n| n.as_str()))
            .collect();
        for name in ALLOWED_RELAY_TOOLS {
            assert!(
                names.contains(&name),
                "bridged tool `{name}` has no registry spec — fix the allowlist entry or add the spec"
            );
        }
    }

    #[test]
    fn every_registry_tool_is_bridged_or_excluded() {
        // THE add-a-tool contract: a tool missing from BOTH lists fails the
        // build here, so a new capability can never silently skip the harness
        // surface again. The failure message names the remaining (prose)
        // surfaces the compiler can't check.
        let caps = ToolCaps {
            local_docs: true,
            browser: true,
            ..Default::default()
        };
        let all = tools::openai_tool_specs(&caps, crate::chat::permission::SandboxPolicy::WorkspaceWrite);
        let names: Vec<&str> = all
            .iter()
            .filter_map(|s| s.pointer("/function/name").and_then(|n| n.as_str()))
            .collect();
        for name in names {
            let classified = ALLOWED_RELAY_TOOLS.contains(&name)
                || BRIDGE_EXCLUDED_TOOLS.iter().any(|(n, _)| *n == name);
            assert!(
                classified,
                "tool `{name}` is neither bridged to harness sessions nor explicitly excluded.\n\
                 Add it to ALLOWED_RELAY_TOOLS (mcp_tools_bridge.rs) so harnesses get it, or to \
                 BRIDGE_EXCLUDED_TOOLS with a reason.\n\
                 Then check the prose surfaces the compiler cannot see: prompts.rs capability \
                 lines, harness_bundle.rs instructions, and the generated-image/FS caveats."
            );
        }
    }
}
