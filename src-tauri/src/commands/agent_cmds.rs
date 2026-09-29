//! Headless CLI chat commands (Phase 2 — see agent_sessions.rs). These back
//! chat sessions whose `agent` is a CLI harness; the built-in chat commands
//! (chat_cmds) keep serving `builtin`/`local` sessions.

use std::sync::Arc;

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

use crate::agent_sessions::AgentSessionState;
use crate::DbState;

/// Warm results of the CLI harness model probes (`pi --list-models` etc.),
/// keyed by harness id — 30s TTL, shared by the desktop picker command and
/// the mobile relay (one probe serves both surfaces).
type HarnessModelsCache =
    std::sync::Mutex<HashMap<String, (Instant, crate::harness_config::HarnessModelConfig)>>;
const HARNESS_MODELS_TTL: Duration = Duration::from_secs(30);
static HARNESS_MODELS_CACHE: Lazy<HarnessModelsCache> =
    Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

/// Send one user turn to the CLI backing this chat session. Spawns the
/// headless process on first use (or on model change).
/// `harnessId` is the chat session's CLI ("claude_code" | "kimi_code" |
/// "opencode"), `model` its selected model id; `cwd` is the working
/// directory the CLI operates in (the selected project's path, when one
/// is selected). `projectId` feeds the relay-browser MCP registration
/// (RELAY_PROJECT_ID) so browser auto-open is scoped to the project.
/// All harnesses are spawned with full permissions — no per-session
/// permission selector is surfaced or consulted.
///
/// Attachments: same composer payload the built-in chat takes. Display
/// markers + extracted document text are folded into the persisted message
/// (identical to `send_chat_message`, so bubbles render attachment cards);
/// image/doc bytes are additionally written under the artifacts dir and
/// referenced by absolute path in a CLI-facing appendix, since harnesses
/// take plain text on stdin — their own file tools open the originals.
///
/// Connectors: attach-on-demand parity with the built-in chat — only
/// connectors attached to this conversation (composer @-picker / keyword
/// mention) are registered into the spawn's MCP config as remote servers
/// with freshly-refreshed OAuth tokens. A fresh harness turn therefore
/// starts with no connector overhead at all.
#[tauri::command]
pub async fn send_agent_chat_message(
    app: AppHandle,
    state: State<'_, AgentSessionState>,
    db: State<'_, DbState>,
    chat_session_id: String,
    content: String,
    harness_id: String,
    model: Option<String>,
    cwd: Option<String>,
    project_id: Option<String>,
    attachments: Option<Vec<crate::types::ChatAttachmentInput>>,
    // Force research mode for this turn (composer "+" toggle / /research
    // route). Like the built-in path, the transcript keeps what the user
    // typed: the protocol rides the CLI-facing appendix (agent_sessions::
    // research_directive), which reaches the model but is never persisted.
    force_research: Option<bool>,
) -> Result<(), String> {
    // Snapshot the session's attached connectors (refreshing OAuth tokens)
    // BEFORE the sync spawn path — the CLIs only read static MCP config at
    // startup, so this is the one place fresh tokens can reach them. This
    // turn's text runs the same keyword fast-path as the built-in chat:
    // "my inbox"/"@gmail" attaches (and persists) the connector here too.
    let connectors =
        crate::connectors::harness_mcp_servers_for_message(&app, &chat_session_id, Some(&content))
            .await;
    let (content, attach_prompt) = match &attachments {
        Some(list) if !list.is_empty() => {
            // Same display markers/extraction the built-in path persists
            // (images become "[Attached image: …]" notes; docs/text inline).
            let (display_extra, _images) = crate::chat::commands::process_attachments(list);
            let prompt =
                crate::agent_sessions::prepare_agent_attachments(&app, &chat_session_id, list);
            (format!("{content}{display_extra}"), prompt)
        }
        _ => (content, String::new()),
    };
    let attach_prompt = if force_research.unwrap_or(false) {
        format!(
            "{}{}",
            attach_prompt,
            crate::agent_sessions::AgentSessionManager::research_directive()
        )
    } else {
        attach_prompt
    };
    // Primer summary (engine-switch handoff): when a fresh CLI session is
    // about to lose older turns to the primer's char budget, pre-summarize
    // them with the shared cloud summarizer — properly awaited here so the
    // network round-trip never blocks the sync spawn path inside send().
    // Failure/None → send() falls back to the truncate-only primer.
    let primer_summary =
        crate::agent_sessions::build_primer_summary(&db, &chat_session_id, &harness_id).await;
    // Run on a blocking worker like `cancel` below: `send` holds the
    // per-session mutex for a whole turn's setup (git snapshot, bundle I/O,
    // process spawn + wait-ready) — a whole blocking `send()` here would pin
    // this tokio worker (including its 20s wait-ready poll) for that long.
    let mgr = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<DbState>();
        mgr.send(
            &app,
            &db,
            &chat_session_id,
            &content,
            &attach_prompt,
            &harness_id,
            model.as_deref().unwrap_or(""),
            cwd.as_deref(),
            project_id.as_deref(),
            &connectors,
            primer_summary.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("send task panicked: {e}"))?
}

/// Cancel the in-flight turn (kills the CLI process; next send respawns).
///
/// Runs on a blocking worker rather than as a sync command: `cancel` blocks on
/// the global `sessions` mutex, which `send` holds for its whole (potentially
/// many-second) turn setup — a sync command would block the MAIN thread and
/// freeze the window for that entire window (audit B-8).
#[tauri::command]
pub async fn cancel_agent_chat_message(
    app: AppHandle,
    state: State<'_, AgentSessionState>,
    chat_session_id: String,
) -> Result<(), String> {
    let mgr = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || mgr.cancel(&app, &chat_session_id))
        .await
        .map_err(|e| format!("cancel task panicked: {e}"))?
}

/// Crash recovery for in-flight turns, called once when the frontend boots
/// (fresh mount after an app launch or a webview reload). A turn's busy flag
/// lives in backend memory: after a reload the chat looks empty yet rejects
/// every send with "a turn is already running", and a panic-killed reader can
/// wedge the flag permanently. Clears the flag for sessions whose reader and
/// child process are both gone; genuinely running turns keep it. Returns the
/// recovered chat session ids.
#[tauri::command]
pub async fn reconcile_agent_sessions(
    state: State<'_, AgentSessionState>,
) -> Result<Vec<String>, String> {
    let mgr = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || Ok(mgr.reconcile_wedged_turns()))
        .await
        .map_err(|e| format!("reconcile task panicked: {e}"))?
}

/// The models/endpoint discovered in the CLI harness's own config files
/// (settings.json / config.toml / opencode.json) — see harness_config.rs.
///
/// Discovery may LIVE-PROBE the CLI (`pi --list-models`, `omp models --json`,
/// `commandcode --list-models` — each a 1–3s node/bun cold start). This used
/// to be a sync command, which Tauri runs on the MAIN thread: opening the
/// agent picker froze the whole window for the length of every probe. It must
/// stay off the main thread (spawn_blocking), and a short TTL cache keeps
/// repeat picker opens free. `force` (the picker's "↻ Refresh from CLI")
/// skips the TTL and re-probes.
#[tauri::command]
pub async fn list_harness_models(
    harness_id: String,
    force: Option<bool>,
) -> Result<crate::harness_config::HarnessModelConfig, String> {
    harness_models_cached(harness_id, force.unwrap_or(false)).await
}

/// The 30s-TTL probe cache behind `list_harness_models`, shared with the
/// mobile relay's `ListHarnessModels` op so one probe serves both surfaces.
pub(crate) async fn harness_models_cached(
    harness_id: String,
    force: bool,
) -> Result<crate::harness_config::HarnessModelConfig, String> {
    if !force {
        if let Some(cfg) = harness_models_cache_get(&harness_id) {
            return Ok(cfg);
        }
    }
    let id = harness_id.clone();
    let cfg = tauri::async_runtime::spawn_blocking(move || {
        crate::harness_config::harness_model_config(&id)
    })
    .await
    .map_err(|e| format!("harness model probe join failed: {e}"))?;
    // Don't cache an empty discovery result: a raced probe (CLI cold start,
    // login refresh mid-run) would read as "zero models" for the whole TTL.
    // Leaving the cache unwritten makes the next picker open re-probe.
    if cfg.models.is_empty() {
        return Ok(cfg);
    }
    if let Ok(mut guard) = HARNESS_MODELS_CACHE.lock() {
        guard.insert(harness_id, (Instant::now(), cfg.clone()));
    }
    Ok(cfg)
}

/// Warm-cache read for surfaces that must never block (the mobile relay's
/// AvailableProviders build runs on the WS task): `None` when the cache is
/// cold or stale — the phone then fetches the pane's catalog on open instead.
pub(crate) fn harness_models_cache_get(
    harness_id: &str,
) -> Option<crate::harness_config::HarnessModelConfig> {
    let guard = HARNESS_MODELS_CACHE.lock().ok()?;
    let (at, cfg) = guard.get(harness_id)?;
    if at.elapsed() < HARNESS_MODELS_TTL {
        Some(cfg.clone())
    } else {
        None
    }
}

/// Warm results of the native-subagent store walks (see
/// `list_harness_subagents`), keyed by "harness_id|project_root" — 30s TTL.
type HarnessSubagentsCache = std::sync::Mutex<
    HashMap<String, (Instant, Vec<crate::harness_config::HarnessSubagentInfo>)>,
>;
const HARNESS_SUBAGENTS_TTL: Duration = Duration::from_secs(30);
static HARNESS_SUBAGENTS_CACHE: Lazy<HarnessSubagentsCache> =
    Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

/// The subagents defined in a CLI harness's OWN markdown store
/// (`~/.claude/agents/*.md` etc. — the per-id directories live in
/// harness_config.rs). The Subagents page lists these per harness and imports
/// a row into Relay's registry with one click.
///
/// Same shape as `list_harness_models`: the walk is blocking filesystem I/O,
/// so it runs on a worker thread (a sync command runs on the MAIN thread and
/// would freeze the window mid-expand) behind a 30s TTL cache keyed by
/// harness id + project_root. Empty results are NOT cached — most stores
/// legitimately don't exist yet (omp only materializes its bundled agents on
/// `omp agents unpack`), and caching that emptiness would hide the rows the
/// moment after the user creates them.
#[tauri::command]
pub async fn list_harness_subagents(
    harness_id: String,
    project_root: Option<String>,
) -> Result<Vec<crate::harness_config::HarnessSubagentInfo>, String> {
    let key = format!("{harness_id}|{}", project_root.as_deref().unwrap_or(""));
    if let Some(rows) = harness_subagents_cache_get(&key) {
        return Ok(rows);
    }
    let id = harness_id.clone();
    let rows = tauri::async_runtime::spawn_blocking(move || {
        crate::harness_config::harness_subagents(&id, project_root.as_deref())
    })
    .await
    .map_err(|e| format!("harness subagent listing join failed: {e}"))?;
    if rows.is_empty() {
        return Ok(rows);
    }
    if let Ok(mut guard) = HARNESS_SUBAGENTS_CACHE.lock() {
        guard.insert(key, (Instant::now(), rows.clone()));
    }
    Ok(rows)
}

fn harness_subagents_cache_get(
    key: &str,
) -> Option<Vec<crate::harness_config::HarnessSubagentInfo>> {
    let guard = HARNESS_SUBAGENTS_CACHE.lock().ok()?;
    let (at, rows) = guard.get(key)?;
    if at.elapsed() < HARNESS_SUBAGENTS_TTL {
        Some(rows.clone())
    } else {
        None
    }
}

/// ACP agents (roadmap #20) for the composer's agent menu: the static
/// Zed/Devin registry plus user-defined entries from the `acp.agents`
/// app_settings blob, each with an install probe. Mirrors `list_harnesses`.
///
/// The probe spawns the agent binary with `--version` (up to 5s per entry),
/// so this is an async command with a 30s TTL cache — same rationale as
/// `list_harnesses`: opening the agent menu must never freeze the window.
#[tauri::command]
pub async fn list_acp_agents(db: State<'_, DbState>) -> Result<Vec<crate::types::AcpAgentStatus>, String> {
    if let Some(list) = acp_status_cache_get() {
        return Ok(list);
    }
    // Snapshot the registry rows synchronously (fast SQLite read), then run
    // the process probes off the main thread.
    let defs = {
        let conn = db.0.lock();
        crate::acp_agents::all_agents(&conn)
    };
    let probed = tauri::async_runtime::spawn_blocking(move || {
        defs.into_iter()
            .map(|a| {
                let installed = crate::acp_agents::is_installed(&a);
                crate::types::AcpAgentStatus {
                    id: a.id,
                    display_name: a.display_name,
                    installed,
                }
            })
            .collect::<Vec<crate::types::AcpAgentStatus>>()
    })
    .await
    .map_err(|e| format!("acp probe join failed: {e}"))?;
    acp_status_cache_store(probed.clone());
    Ok(probed)
}

/// Cached `list_acp_agents` probe results — see that command. TTL matches
/// `list_harnesses`; edits via save/delete of ACP agents are rare and the
/// settings panel re-probes explicitly.
static ACP_STATUS_CACHE: once_cell::sync::Lazy<
    std::sync::Mutex<Option<(std::time::Instant, Vec<crate::types::AcpAgentStatus>)>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));
const ACP_STATUS_TTL: std::time::Duration = std::time::Duration::from_secs(30);

fn acp_status_cache_get() -> Option<Vec<crate::types::AcpAgentStatus>> {
    let guard = ACP_STATUS_CACHE.lock().ok()?;
    let (at, list) = guard.as_ref()?;
    if at.elapsed() < ACP_STATUS_TTL {
        Some(list.clone())
    } else {
        None
    }
}

fn acp_status_cache_store(list: Vec<crate::types::AcpAgentStatus>) {
    if let Ok(mut guard) = ACP_STATUS_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), list));
    }
}

/// Register a typed `Channel<ChatTokenPayload>` for a chat session. The
/// chat streaming code in `chat::dispatch::emit_token` and the headless CLI
/// chat path in `agent_sessions::emit_token` will route tokens through this
/// channel when one is registered; otherwise they fall back to
/// `app.emit("chat:token", ...)` (preserving the legacy event path for
/// tests and any frontend that hasn't migrated).
///
/// One subscriber per session. The frontend is expected to call this once
/// per chat-session open; the channel is dropped automatically when the
/// React effect unmounts.
#[tauri::command]
pub fn chat_token_subscribe(
    session_id: String,
    channel: tauri::ipc::Channel<crate::types::ChatTokenPayload>,
) -> Result<(), String> {
    crate::chat::stream_events::register(&session_id, channel);
    Ok(())
}
