//! Headless CLI chat sessions (Phase 2 — mockups/04 "Option B").
//!
//! Chat sessions whose `agent` is a CLI harness (`harness:claude_code`, …)
//! are backed by real CLI processes instead of the built-in ChatManager's
//! direct HTTP calls. Two spawn styles, normalized onto the SAME Tauri events
//! the built-in chat emits (`chat:token` / `chat:done` / `chat:error`):
//!
//! - **claude_code** — one persistent process per chat:
//!   `claude -p --input-format stream-json --output-format stream-json
//!   --verbose --include-partial-messages`. Each turn is a JSON line on
//!   stdin; token deltas arrive via `stream_event` wrappers and the turn
//!   closes with a `result` event carrying usage + cost.
//! - **kimi_code / opencode** — one process per turn:
//!   `kimi -p <prompt> --output-format stream-json [-m model] [--session id]`
//!   `opencode run <prompt> --format json [-m provider/model] [-s id]`
//!   The CLI's own session id (from the first turn's output) is passed back
//!   on later turns so the conversation continues; process exit closes the
//!   turn. The id is kept in memory AND persisted to app_settings
//!   (`agent.cli_session_id.<harness>.<sid>`), so multi-turn context survives
//!   cancels (which keep the entry, only killing the process tree) and app
//!   restarts. claude_code captures its `session_id` from result events the
//!   same way and passes `--resume` when the persistent process is respawned.
//!
//! Tool calls are encoded as `<tool>{json}</tool>` markers inline in the
//! token stream — the exact format MessageBubble / DiffCard and the history
//! sanitizer already parse (see chat/proto.rs). The frontend needed no new
//! rendering: only send/cancel routing.
//!
//! A third entry point, `run_one_shot`, runs one blocking self-contained
//! turn (no persistent process, no CLI session resume) and works with or
//! without a Tauri AppHandle — it backs scheduled automations, both from the
//! in-app scheduler and from the standalone `conduit-automation` binary.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::browser::BROWSER_MCP_PORT;
use crate::browser_mcp_register;
use crate::harness_adapters::{resolve_for_spawn, CommandSpec};
use crate::DbState;

/// Tauri state wrapper (registered in lib.rs).
pub struct AgentSessionState(pub Arc<AgentSessionManager>);

pub struct AgentSessionManager {
    sessions: Mutex<HashMap<String, AgentChild>>,
}

/// When the CLI (running with `--permission-mode acceptEdits`) encounters
/// a dangerous operation (bash, delete), it pauses and waits for an stdin
/// approval. This state bridges that wait into the frontend's approval-card
/// system: the reader thread fills it in and spin-waits on `resolved`, while
/// a Tauri command (`resolve_agent_approval`) sets `approved` + `resolved`
/// from the frontend. The reader then writes the decision to stdin.
struct ApprovalRelay {
    tool_name: String,
    /// JSON input args for the tool — surfaced in the approval card.
    tool_input: serde_json::Value,
    resolved: Arc<AtomicBool>,
    approved: Arc<AtomicBool>,
}

struct AgentChild {
    harness: String,
    /// Model the session was last spawned with — a model change respawns
    /// (claude) or just applies to the next per-turn process.
    model: String,
    /// The chat session's permission mode (read_only | manual | auto_edit |
    /// full_auto), mapped onto each CLI's own permission flags at spawn.
    perm: String,
    /// claude_code: the persistent process (always Some).
    /// kimi/opencode: Some only while a turn's process is running.
    child: Option<Child>,
    /// claude_code: the model the persistent process was spawned with —
    /// a change kills and respawns it.
    spawned_model: Option<String>,
    /// claude_code: the permission mode the persistent process was spawned
    /// with — `--permission-mode` is spawn-time only, so a change respawns.
    spawned_perm: Option<String>,
    /// The CLI's own session id, captured from turn output and passed back
    /// to continue the conversation (kimi `--session`, opencode `-s`,
    /// claude `--resume` on respawn). Shared with the reader thread, which
    /// fills it in; also persisted to app_settings so context survives
    /// cancels and app restarts.
    cli_session_id: Arc<Mutex<Option<String>>>,
    /// Set while a turn is streaming; cleared on result/exit.
    turn_in_flight: Arc<AtomicBool>,
    /// Set by `cancel` for the CURRENT turn/process only. Replaced with a
    /// fresh flag on every (re)spawn, so a late-finishing reader thread from
    /// a cancelled turn still sees `true` (skips persisting the partial
    /// reply) even after the user has already sent the next message.
    cancelled: Arc<AtomicBool>,
    /// Shared stdin for writing approval responses from the reader thread
    /// (or from the resolve_agent_approval Tauri command). Only meaningful
    /// for the persistent-process path; per-turn CLIs have Stdio::null().
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    /// Pending approval relay — filled by the reader thread when the CLI
    /// waits for permission on a dangerous operation. The frontend resolves
    /// it via `resolve_agent_approval`.
    pending_approval: Arc<Mutex<Option<ApprovalRelay>>>,
}

impl AgentSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Send one user turn. The harness id comes from the chat session's
    /// `agent` field ("harness:<id>"), passed by the command layer.
    pub fn send(
        &self,
        app: &AppHandle,
        db: &DbState,
        chat_session_id: &str,
        content: &str,
        harness: &str,
        model: &str,
        perm: &str,
        cwd: Option<&str>,
        project_id: Option<&str>,
    ) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let entry = sessions
            .entry(chat_session_id.to_string())
            .or_insert_with(|| {
                // Restore a previously captured CLI session id (persisted by
                // the reader thread at end of turn) so conversation context
                // survives app restarts, not just cancels.
                let stored = {
                    let conn = db.0.lock();
                    crate::db::get_setting(&conn, &cli_session_key(harness, chat_session_id))
                        .ok()
                        .flatten()
                };
                AgentChild {
                    harness: harness.to_string(),
                    model: model.to_string(),
                    perm: perm.to_string(),
                    child: None,
                    spawned_model: None,
                    spawned_perm: None,
                    cli_session_id: Arc::new(Mutex::new(stored)),
                    turn_in_flight: Arc::new(AtomicBool::new(false)),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    stdin: Arc::new(Mutex::new(None)),
                    pending_approval: Arc::new(Mutex::new(None)),
                }
            });
        // Harness switch on an existing chat: kill the old CLI's process and
        // drop its resume id — a kimi session id means nothing to opencode.
        if entry.harness != harness {
            if let Some(mut child) = entry.child.take() {
                kill_child_tree(&mut child);
            }
            entry.harness = harness.to_string();
            entry.spawned_model = None;
            entry.spawned_perm = None;
            if let Ok(mut g) = entry.cli_session_id.lock() {
                *g = None;
            }
        }
        // Check turn-in-flight BEFORE persisting the user message, so a
        // rejected send doesn't leave an orphan user message in the DB
        // with no assistant reply (which would survive restarts).
        if entry.turn_in_flight.load(Ordering::SeqCst) {
            return Err("a turn is already running for this chat".to_string());
        }
        entry.model = model.to_string();
        entry.perm = perm.to_string();

        // Mirror the built-in chat: the user message is persisted up front so
        // history survives a crash mid-turn. Done AFTER the turn-in-flight
        // check so a rejected turn can't orphan a user message.
        {
            let conn = db.0.lock();
            crate::db::add_chat_message(&conn, chat_session_id, "user", content, None, None, None)
                .map_err(|e| e.to_string())?;
        }

        // Prepend the user's custom system prompt (Settings → Assistant) so the
        // harness CLI receives the same persona the built-in chat does. If the
        // user set one, it goes first, separated from their message by a blank
        // line. The original content is persisted to the DB without the prefix
        // (the system prompt is separate config, not part of the message).
        let effective = {
            let conn = db.0.lock();
            let custom: Option<String> =
                crate::db::get_setting(&conn, "assistant.systemPrompt").ok().flatten();
            match custom {
                Some(sp) if !sp.trim().is_empty() => {
                    format!("{sp}\n\n---\n\n{content}")
                }
                _ => content.to_string(),
            }
        };

        match harness {
            "claude_code" => send_claude_turn(app, db, chat_session_id, &effective, entry, cwd, project_id),
            "kimi_code" => spawn_per_turn(app, db, chat_session_id, &effective, entry, cwd, project_id, PerTurn::Kimi),
            "opencode" => spawn_per_turn(app, db, chat_session_id, &effective, entry, cwd, project_id, PerTurn::OpenCode),
            other => Err(format!("harness '{other}' has no headless chat backend yet")),
        }
    }

    /// Cancel the in-flight turn by killing the process tree (claude has no
    /// graceful interrupt over stream-json input; per-turn CLIs are simply
    /// killed mid-run). Next send respawns. Matches the built-in chat's
    /// cancel semantics: the turn is discarded.
    ///
    /// The session entry is KEPT (only the process is killed and the turn
    /// flagged `cancelled`): the captured CLI session id must survive the
    /// cancel or the next turn would start a blank conversation. The
    /// `cancelled` flag tells the dying process's reader thread not to
    /// persist the partial reply or emit a second `chat:done`. State is
    /// dropped only when the chat itself is deleted (`remove_session`).
    pub fn cancel(&self, app: &AppHandle, chat_session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = sessions.get_mut(chat_session_id) {
            entry.cancelled.store(true, Ordering::SeqCst);
            if let Some(mut child) = entry.child.take() {
                kill_child_tree(&mut child);
            }
            entry.turn_in_flight.store(false, Ordering::SeqCst);
        }
        emit_done(Some(app), chat_session_id, None, None, None);
        Ok(())
    }

    /// Resolve a pending harness approval. Called from the frontend when the
    /// user clicks Approve/Deny on the approval card. Sets the resolved +
    /// approved flags so the reader thread wakes up and writes the decision
    /// to the CLI's stdin.
    pub fn resolve_approval(&self, chat_session_id: &str, approved: bool) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let entry = sessions
            .get(chat_session_id)
            .ok_or_else(|| "no agent session for this chat".to_string())?;
        let mut pa = entry
            .pending_approval
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(ref relay) = *pa {
            relay.approved.store(approved, Ordering::SeqCst);
            relay.resolved.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    /// Drop all state for a deleted chat: kill any running process tree and
    /// forget the in-memory CLI session id (the persisted app_settings keys
    /// are removed by the delete_chat_session command).
    pub fn remove_session(&self, chat_session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(mut entry) = sessions.remove(chat_session_id) {
                entry.cancelled.store(true, Ordering::SeqCst);
                if let Some(mut child) = entry.child.take() {
                    kill_child_tree(&mut child);
                }
            }
        }
    }

    /// Kill all children (app shutdown).
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut c) in sessions.drain() {
                if let Some(mut child) = c.child.take() {
                    kill_child_tree(&mut child);
                }
            }
        }
    }
}

/// Kill a spawned harness process AND its whole process tree. On Windows
/// every spawn is wrapped in `cmd.exe /C` (harness_adapters::resolve_for_spawn),
/// so the `Child` handle is the shell: `Child::kill()` terminates only
/// cmd.exe while the real CLI (the node.exe grandchild) survives, keeps the
/// stdout pipe open, and the turn visibly keeps running after cancel.
/// Kill the process tree. On Windows `taskkill /T /F` is the primary kill;
/// `child.kill()` + `child.wait()` is the fallback that always reaps the
/// direct handle. The stdio pipes are dropped here too (stdin/stdout/stderr
/// live on `Child`), which unblocks the reader thread so it can observe the
/// `cancelled` flag and exit without emitting a spurious `chat:done`.
fn kill_child_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        // Kill the entire process tree first so no grandchildren survive.
        let pid = child.id();
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", pid.to_string().as_str(), "/T", "/F"]);
        no_console_window(&mut cmd);
        // Best-effort — taskkill can fail if the tree already exited, but
        // the direct kill+wait below still reaps the handle either way.
        let _ = cmd.status();
    }
    // Kill the direct child (belt) and wait for it to be reaped (suspenders).
    // On non-Windows this is the only kill; on Windows it cleans up if
    // taskkill failed or the child was already a zombie.
    let _ = child.kill();
    let _ = child.wait();
    // Explicitly take stdin so the reader thread's BufReader::lines() loop
    // ends when the stdout pipe closes — without this a stale stdin
    // reference can keep the pipe alive on some platforms.
    drop(child.stdin.take());
}

/// DB key for the per-chat, per-harness CLI session id (kimi `--session`,
/// opencode `-s`, claude `--resume`). Harness-qualified so switching harness
/// on the same chat never resumes the wrong CLI's conversation.
fn cli_session_key(harness: &str, sid: &str) -> String {
    format!("agent.cli_session_id.{harness}.{sid}")
}

/// Persist the captured CLI session id (if any) so conversation context
/// survives cancels and app restarts. Called by reader threads at end of
/// turn / process exit.
fn persist_cli_session_id(
    db: &DbState,
    harness: &str,
    sid: &str,
    cell: &Arc<Mutex<Option<String>>>,
) {
    let id = cell.lock().ok().and_then(|g| g.clone());
    if let Some(id) = id {
        let conn = db.0.lock();
        let _ = crate::db::set_setting(&conn, &cli_session_key(harness, sid), &id);
    }
}

// ---------------------------------------------------------------- claude_code

/// Persistent-process path: spawn on first use (or on model change), then
/// write the turn as a stream-json stdin line.
fn send_claude_turn(
    app: &AppHandle,
    db: &DbState,
    sid: &str,
    content: &str,
    entry: &mut AgentChild,
    cwd: Option<&str>,
    project_id: Option<&str>,
) -> Result<(), String> {
    if entry.child.is_none()
        || entry.spawned_model.as_deref() != Some(entry.model.as_str())
        || entry.spawned_perm.as_deref() != Some(entry.perm.as_str())
    {
        if let Some(mut old) = entry.child.take() {
            kill_child_tree(&mut old);
        }
        // Fresh per-process cancel flag: a respawn after cancel() must not
        // inherit the previous process's `true`.
        let cancelled = Arc::new(AtomicBool::new(false));
        entry.cancelled = Arc::clone(&cancelled);
        entry.child = Some(spawn_claude(
            app,
            db,
            sid,
            &entry.model,
            &entry.perm,
            cwd,
            project_id,
            &entry.turn_in_flight,
            &entry.cli_session_id,
            &cancelled,
            &entry.stdin,
            &entry.pending_approval,
        )?);
        entry.spawned_model = Some(entry.model.clone());
        entry.spawned_perm = Some(entry.perm.clone());
    }

    let line = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": content }],
        },
    })
    .to_string();
    {
        let mut guard = entry.stdin.lock().map_err(|e| e.to_string())?;
        let stdin = guard.as_mut().ok_or("agent process stdin is closed")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("failed to write to CLI stdin: {e}"))?;
    }
    entry.turn_in_flight.store(true, Ordering::SeqCst);
    Ok(())
}

/// Map our catalog/config model ids to what `claude --model` accepts:
/// aliases ("fable" | "opus" | "sonnet" | "haiku") resolve through the CLI's
/// own settings (including relay remaps); anything else passes through.
fn claude_model_alias(model: &str) -> String {
    let m = model.to_lowercase();
    if m.contains("fable") {
        "fable".to_string()
    } else if m.contains("opus") {
        "opus".to_string()
    } else if m.contains("sonnet") {
        "sonnet".to_string()
    } else if m.contains("haiku") {
        "haiku".to_string()
    } else {
        model.to_string()
    }
}

/// Map the chat session's permission mode onto `claude --permission-mode`.
/// read_only runs as plan mode (no mutations).
/// manual / auto_edit both use acceptEdits: file reads+writes auto-approve,
/// dangerous ops (bash, delete) pause for approval via an stdin relay
/// (see the `permission_ask` event handler in the reader loop).
/// full_auto bypasses all permission checks.
fn claude_permission_mode(perm: &str) -> &'static str {
    match perm {
        "read_only" => "plan",
        "manual" => "acceptEdits",
        "auto_edit" => "acceptEdits",
        "full_auto" => "bypassPermissions",
        _ => "acceptEdits",
    }
}

/// Working directory for agent spawns. With no project selected the CLI
/// would otherwise inherit the app's own cwd — under `tauri dev` that's the
/// repo root, so generated files land in the app folder and the CLI's
/// sandbox then refuses paths outside it. Fall back to the configured
/// artifacts dir (`storage.artifactsDir`) when set, else Documents/Conduit
/// (the same default the built-in chat uses) instead.
fn spawn_dir(
    cwd: Option<&str>,
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Option<std::path::PathBuf> {
    let dir = cwd.map(std::path::PathBuf::from).or_else(|| {
        let configured = {
            let conn = db.lock();
            crate::chat::dispatch::configured_artifacts_dir(&conn)
        };
        configured.or_else(|| {
            dirs::document_dir()
                .or_else(dirs::home_dir)
                .map(|base| base.join("Conduit"))
        })
    });
    if let Some(d) = &dir {
        let _ = std::fs::create_dir_all(d);
    }
    dir
}

/// A harness turn's spawn directory plus its pre-turn snapshot, moved into
/// the reader thread. `finish_turn` diffs the directory against the snapshot
/// to surface files the CLI created or modified as artifacts (the built-in
/// chat gets the same via tool outcomes in chat/dispatch.rs).
struct DirWatch {
    dir: PathBuf,
    before: HashMap<String, (SystemTime, u64)>,
}

impl DirWatch {
    fn new(dir: PathBuf) -> Self {
        let before = snapshot_dir(&dir);
        Self { dir, before }
    }
}

/// Relative path → (mtime, len) for every file under `dir`: depth ≤ 4, hidden
/// dirs / .git / node_modules / target skipped, ~2000 entries max. Taken
/// before a harness turn and diffed after it (see changed_previewable_files).
fn snapshot_dir(dir: &Path) -> HashMap<String, (SystemTime, u64)> {
    const MAX_ENTRIES: usize = 2000;
    let mut out = HashMap::new();
    let walker = walkdir::WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 || !e.file_type().is_dir() {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules" && name != "target"
        });
    for entry in walker.flatten() {
        if out.len() >= MAX_ENTRIES {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if let Ok(md) = entry.metadata() {
            let rel = entry
                .path()
                .strip_prefix(dir)
                .unwrap_or_else(|_| entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            out.insert(rel, (md.modified().unwrap_or(SystemTime::UNIX_EPOCH), md.len()));
        }
    }
    out
}

/// Files that are NEW or MODIFIED (mtime or length changed) between the two
/// snapshots AND whose extension the artifact preview supports — the same
/// classification read_artifact_preview uses (text/code, image, pdf, office).
fn changed_previewable_files(
    before: &HashMap<String, (SystemTime, u64)>,
    after: &HashMap<String, (SystemTime, u64)>,
) -> Vec<String> {
    let mut out: Vec<String> = after
        .iter()
        .filter(|(rel, meta)| match before.get(rel.as_str()) {
            Some(prev) => prev != *meta,
            None => true,
        })
        .filter(|(rel, _)| previewable_ext(rel))
        .map(|(rel, _)| rel.clone())
        .collect();
    out.sort();
    out
}

/// Extension allow-list mirrored from read_artifact_preview's classification
/// (chat/commands.rs): text/code kinds, images, pdf, and Office documents.
fn previewable_ext(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "md" | "markdown" | "csv" | "json" | "html" | "htm" | "txt" | "log" | "text"
            | "js" | "ts" | "tsx" | "jsx" | "py" | "rs" | "go" | "java" | "c" | "cpp" | "h"
            | "hpp" | "sh" | "bash" | "yaml" | "yml" | "toml" | "xml" | "sql" | "rb" | "php"
            | "css"
            | "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp"
            | "pdf"
            | "docx" | "pptx" | "xlsx"
    )
}

/// Resolve (writing if needed) the per-project `.mcp.json` registering the
/// conduit-browser MCP server — same helper pty_cmds.rs uses for Dev-tab PTY
/// sessions. Returns None (silently skipping browser tools for the turn) when
/// no project is selected, the MCP binary isn't present, or the write fails:
/// registration failure must never fail the turn.
fn resolve_mcp_config(app: &AppHandle, project_id: Option<&str>) -> Option<std::path::PathBuf> {
    let data_dir = app.path().app_data_dir().ok()?;
    browser_mcp_register::write_mcp_config(&data_dir, project_id?, BROWSER_MCP_PORT)
}

/// Same, but OpenCode-format: opencode has no `--mcp-config` flag — it reads
/// MCP servers from an opencode.json "mcp" section, pointed at via the
/// OPENCODE_CONFIG env var on the spawn.
fn resolve_opencode_config(app: &AppHandle, project_id: Option<&str>) -> Option<std::path::PathBuf> {
    let data_dir = app.path().app_data_dir().ok()?;
    browser_mcp_register::write_opencode_config(&data_dir, project_id?, BROWSER_MCP_PORT)
}

/// The artifacts dir the bundle should advertise: the spawn dir when set
/// (it IS the CLI's workspace), else the configured artifacts dir, else the
/// Documents/Conduit default — mirroring `spawn_dir`.
fn artifacts_dir_for_bundle(app: &AppHandle, cwd: Option<&str>) -> String {
    if let Some(c) = cwd { return c.to_string(); }
    crate::chat::dispatch::artifacts_dir(app).to_string_lossy().into_owned()
}

/// Resolve (writing if needed) the per-project harness bundle. Returns None
/// when no project is selected or the write fails — bundle failure must
/// never fail the turn (same contract as the old resolve_mcp_config).
fn resolve_harness_bundle(
    app: &AppHandle,
    project_id: Option<&str>,
    cwd: Option<&str>,
    artifacts_dir: String,
) -> Option<crate::harness_bundle::HarnessBundlePaths> {
    let data_dir = app.path().app_data_dir().ok()?;
    crate::harness_bundle::write_bundle(
        &data_dir, project_id?, cwd, Some(artifacts_dir.as_str()), crate::browser::BROWSER_MCP_PORT)
}

fn spawn_claude(
    app: &AppHandle,
    db: &DbState,
    sid: &str,
    model: &str,
    perm: &str,
    cwd: Option<&str>,
    project_id: Option<&str>,
    in_flight: &Arc<AtomicBool>,
    session_cell: &Arc<Mutex<Option<String>>>,
    cancelled: &Arc<AtomicBool>,
    shared_stdin: &Arc<Mutex<Option<std::process::ChildStdin>>>,
    pending_approval: &Arc<Mutex<Option<ApprovalRelay>>>,
) -> Result<Child, String> {
    let alias = claude_model_alias(model);
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
        "--permission-mode".into(),
        claude_permission_mode(perm).into(),
        "--model".into(),
        alias,
    ];
    // Respawning (after a cancel, model/perm change, or app restart) would
    // start a blank conversation — resume the captured CLI session instead.
    let resume = session_cell.lock().ok().and_then(|g| g.clone());
    if let Some(id) = &resume {
        args.push("--resume".into());
        args.push(id.clone());
    }
    // Conduit-owned bundle: instructions, permissions, and both MCP servers
    // (browser + tools). Registration failure degrades to no extra flags —
    // the turn still runs, just without conduit's prompt/tools.
    if let Some(bundle) = resolve_harness_bundle(app, project_id, cwd, artifacts_dir_for_bundle(app, cwd)) {
        args.extend(crate::harness_bundle::claude_bundle_args(&bundle, &artifacts_dir_for_bundle(app, cwd)));
    }
    let spec = resolve_for_spawn(&CommandSpec {
        program: "claude".into(),
        args,
    });
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Snapshot the spawn dir once per (re)spawn so finish_turn can diff it
    // after each turn and surface files the CLI created as artifacts.
    let mut watch = None;
    if let Some(dir) = spawn_dir(cwd, &db.0) {
        cmd.current_dir(&dir);
        watch = Some(DirWatch::new(dir));
    }
    no_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn claude CLI: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture claude stdout")?;
    // Take stdin and share it so the reader thread can write approval
    // responses when the CLI pauses on dangerous operations.
    {
        let mut guard = shared_stdin.lock().map_err(|e| e.to_string())?;
        *guard = child.stdin.take();
    }
    let app2 = app.clone();
    let db2 = DbState(Arc::clone(&db.0));
    let sid2 = sid.to_string();
    let in_flight2 = Arc::clone(in_flight);
    let session_cell2 = Arc::clone(session_cell);
    let cancelled2 = Arc::clone(cancelled);
    let stdin2 = Arc::clone(shared_stdin);
    let approval2 = Arc::clone(pending_approval);
    std::thread::spawn(move || {
        read_claude_stream(
            Some(&app2),
            &db2,
            &sid2,
            stdout,
            &in_flight2,
            &session_cell2,
            &cancelled2,
            stdin2,
            approval2,
            watch,
        );
    });
    Ok(child)
}

/// Fire the approval relay for a dangerous tool the CLI is about to execute.
/// Sets the pending-approval state, emits `chat:approval-request` to the
/// frontend, and spin-waits until the user resolves the card (or the turn is
/// cancelled). On resolution writes the decision to the CLI's stdin so the
/// tool either executes or is denied with a text fallback.
fn relay_dangerous_tool(
    app: &AppHandle,
    sid: &str,
    tool_name: &str,
    tool_input: Value,
    shared_stdin: &Arc<Mutex<Option<std::process::ChildStdin>>>,
    pending_approval: &Arc<Mutex<Option<ApprovalRelay>>>,
    cancelled: &AtomicBool,
) {
    let resolved = Arc::new(AtomicBool::new(false));
    let approved = Arc::new(AtomicBool::new(false));
    {
        let mut pa = pending_approval.lock().unwrap();
        *pa = Some(ApprovalRelay {
            tool_name: tool_name.to_string(),
            tool_input: tool_input.clone(),
            resolved: Arc::clone(&resolved),
            approved: Arc::clone(&approved),
        });
    }

    let _ = app.emit(
        "chat:approval-request",
        crate::types::ChatApprovalRequestPayload {
            chat_session_id: sid.to_string(),
            pending_id: format!("harness-{sid}-{tool_name}"),
            tool: tool_name.to_string(),
            summary: format!("Harness wants to run: {tool_name}"),
            args: tool_input.clone(),
        },
    );

    // Spin-wait for resolve_agent_approval (or cancel).
    while !resolved.load(Ordering::SeqCst) && !cancelled.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(100));
    }

    let allow = approved.load(Ordering::SeqCst);
    {
        let mut pa = pending_approval.lock().unwrap();
        *pa = None;
    }

    if let Ok(mut guard) = shared_stdin.lock() {
        if let Some(stdin) = guard.as_mut() {
            let resp = if allow {
                json!({"type":"tool_approval","approve":true})
            } else {
                json!({"type":"tool_approval","approve":false})
            };
            let _ = write!(stdin, "{resp}\n");
            let _ = stdin.flush();
        }
    }
}

/// Reader loop for the persistent claude process: one JSON event per line.
fn read_claude_stream(
    app: Option<&AppHandle>,
    db: &DbState,
    sid: &str,
    stdout: impl std::io::Read,
    in_flight: &AtomicBool,
    session_cell: &Arc<Mutex<Option<String>>>,
    cancelled: &AtomicBool,
    shared_stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    pending_approval: Arc<Mutex<Option<ApprovalRelay>>>,
    mut watch: Option<DirWatch>,
) {
    let mut full = String::new();
    // Whether a thinking block is currently streaming: thinking deltas are
    // wrapped in `<think>…</think>` markers (the frontend renders them as a
    // collapsible block), mirroring anthropic_stream_round in
    // chat/streaming.rs.
    let mut in_think = false;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            // Token streaming (requires --include-partial-messages): raw
            // deltas wrapped in stream_event.
            Some("stream_event") => {
                let delta = v.pointer("/event/delta");
                match delta
                    .and_then(|d| d.get("type"))
                    .and_then(|t| t.as_str())
                {
                    Some("text_delta") => {
                        if let Some(text) = delta
                            .and_then(|d| d.get("text"))
                            .and_then(|t| t.as_str())
                        {
                            if in_think {
                                full.push_str("</think>");
                                emit_token(app, sid, "</think>");
                                in_think = false;
                            }
                            full.push_str(text);
                            emit_token(app, sid, text);
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta
                            .and_then(|d| d.get("thinking"))
                            .and_then(|t| t.as_str())
                        {
                            if !in_think {
                                full.push_str("<think>");
                                emit_token(app, sid, "<think>");
                                in_think = true;
                            }
                            full.push_str(text);
                            emit_token(app, sid, text);
                        }
                    }
                    // A tool_use content_block_start with a dangerous tool
                    // (bash, run_shell, delete_files) means the CLI is about
                    // to wait for stdin approval. Fire the relay NOW — before
                    // the CLI pauses — so the frontend can show the approval
                    // card. The `assistant` handler also checks, but that
                    // event arrives AFTER the tool is approved/denied; this
                    // stream_event path catches it before the wait.
                    Some("content_block_start") => {
                        let block = delta
                            .and_then(|d| d.get("content_block"))
                            .or_else(|| v.pointer("/event/content_block"));
                        if let Some(block) = block {
                            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                let name = block
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("");
                                if name == "bash" || name == "run_shell" || name == "delete_files" {
                                    if let Some(app) = app {
                                        relay_dangerous_tool(
                                            app,
                                            sid,
                                            name,
                                            block.get("input").cloned().unwrap_or(json!({})),
                                            &shared_stdin,
                                            &pending_approval,
                                            cancelled,
                                        );
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            // Complete assistant message: text already streamed via deltas —
            // only tool_use blocks are extracted here. The stream_event
            // content_block_start handler already fires the relay for
            // dangerous tools before the CLI waits for stdin; this path is
            // a safety net for cases where the stream event wasn't caught.
            Some("assistant") => {
                if in_think {
                    full.push_str("</think>");
                    emit_token(app, sid, "</think>");
                    in_think = false;
                }
                if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                    // Safety-net relay for dangerous tools.
                    for block in blocks.iter().filter(|b| {
                        b.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                    }) {
                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        if (name == "bash" || name == "run_shell" || name == "delete_files")
                            && app.is_some()
                        {
                            relay_dangerous_tool(
                                app.unwrap(),
                                sid,
                                name,
                                block.get("input").cloned().unwrap_or(json!({})),
                                &shared_stdin,
                                &pending_approval,
                                cancelled,
                            );
                        }
                    }

                    for marker in blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
                        .filter_map(tool_marker_claude)
                    {
                        full.push_str(&marker);
                        emit_token(app, sid, &marker);
                    }
                }
            }
            Some("result") => {
                // Capture the CLI's session id so a later respawn can
                // `--resume` this conversation instead of starting blank.
                if let Some(id) = v.get("session_id").and_then(|s| s.as_str()) {
                    if let Ok(mut g) = session_cell.lock() {
                        *g = Some(id.to_string());
                    }
                    persist_cli_session_id(db, "claude_code", sid, session_cell);
                }
                let ok = v.get("subtype").and_then(|s| s.as_str()) == Some("success");
                in_flight.store(false, Ordering::SeqCst);
                if cancelled.load(Ordering::SeqCst) {
                    // Turn was cancelled while in flight: discard the partial
                    // reply — cancel() already emitted `chat:done`.
                    full.clear();
                } else if ok {
                    // A turn that ends mid-thinking (rare) still needs the
                    // closing marker or the block renders open forever.
                    if in_think {
                        full.push_str("</think>");
                        emit_token(app, sid, "</think>");
                        in_think = false;
                    }
                    let usage = v.get("usage");
                    let input = usage.and_then(|u| u.get("input_tokens")).and_then(|t| t.as_i64());
                    let output = usage.and_then(|u| u.get("output_tokens")).and_then(|t| t.as_i64());
                    let cost = v.get("total_cost_usd").and_then(|c| c.as_f64());
                    finish_turn(app, db, sid, &mut full, input, output, cost, &mut watch);
                } else {
                    let msg = v
                        .get("error")
                        .and_then(|e| e.as_str())
                        .or_else(|| v.get("result").and_then(|r| r.as_str()))
                        .unwrap_or("Claude Code turn failed")
                        .to_string();
                    full.clear();
                    emit_error(app, sid, &msg);
                }
            }
            // system(init/hooks/status), user (tool results), rate_limit, …
            // — not needed for rendering.
            _ => {}
        }
    }
    // EOF: the process died. Close any open thinking block, persist any
    // captured session id, and if a turn was in flight it never delivered a
    // result — surface that instead of leaving the spinner up forever
    // (unless we killed it ourselves via cancel, which already emitted
    // `chat:done`).
    if in_think {
        full.push_str("</think>");
        emit_token(app, sid, "</think>");
    }
    persist_cli_session_id(db, "claude_code", sid, session_cell);
    if in_flight.swap(false, Ordering::SeqCst) && !cancelled.load(Ordering::SeqCst) {
        emit_error(app, sid, "Claude Code exited mid-turn");
    }
}

// ------------------------------------------------------ per-turn CLIs (kimi/opencode)

/// Which per-turn CLI a spawn targets.
enum PerTurn {
    Kimi,
    OpenCode,
}

/// Spawn a fresh one-shot process for a single turn, resuming the CLI's own
/// session when we have its id from a previous turn.
fn spawn_per_turn(
    app: &AppHandle,
    db: &DbState,
    sid: &str,
    content: &str,
    entry: &mut AgentChild,
    cwd: Option<&str>,
    project_id: Option<&str>,
    kind: PerTurn,
) -> Result<(), String> {
    let resume = entry.cli_session_id.lock().ok().and_then(|g| g.clone());
    // Conduit-owned bundle: instructions, permissions, and MCP registration.
    // Failure degrades to the legacy browser-only configs below (or none).
    let bundle = resolve_harness_bundle(app, project_id, cwd, artifacts_dir_for_bundle(app, cwd));
    // Legacy fallback: browser-only MCP when the bundle (or its mcp part)
    // didn't write — keeps pty-style browser tools working in degraded mode.
    let opencode_legacy_cfg = if bundle.is_none() {
        resolve_opencode_config(app, project_id)
    } else {
        None
    };
    let spec = match kind {
        PerTurn::Kimi => {
            let mut args: Vec<String> = vec![
                "-p".into(),
                content.into(),
                "--output-format".into(),
                "stream-json".into(),
            ];
            // Permission mode is NOT mapped: kimi refuses `--yolo`/`--auto`
            // in combination with `-p` ("Cannot combine --prompt with
            // --yolo"), so prompt mode always runs under the CLI's own
            // non-interactive policy regardless of the selector.
            if !entry.model.is_empty() {
                args.push("-m".into());
                args.push(entry.model.clone());
            }
            if let Some(id) = &resume {
                // Verified against `kimi --help` (v0.31): `-S, --session <id>`.
                args.push("--session".into());
                args.push(id.clone());
            }
            // Bundle args cover --mcp-config-file, --agent-file (fresh only),
            // and --add-dir. kimi_bundle_args skips --agent-file when resuming
            // (kimi forbids it with --session). When bundle is None, nothing is
            // added — matching today's degraded behavior (no browser tools).
            if let Some(b) = &bundle {
                args.extend(crate::harness_bundle::kimi_bundle_args(
                    b, &artifacts_dir_for_bundle(app, cwd), resume.is_some()));
            }
            resolve_for_spawn(&CommandSpec {
                program: "kimi".into(),
                args,
            })
        }
        PerTurn::OpenCode => {
            // -- terminator defends against flag smuggling when content
            // starts with a dash.
            let mut args: Vec<String> = vec!["run".into(), "--".into(), content.into(), "--format".into(), "json".into()];
            if !entry.model.is_empty() {
                args.push("-m".into());
                args.push(entry.model.clone());
            }
            // Permission mapping: full_auto → `--auto` (auto-approve anything
            // not explicitly denied); read_only → the read-only plan agent.
            // manual/auto_edit keep the CLI's default headless policy.
            match entry.perm.as_str() {
                "full_auto" => args.push("--auto".into()),
                "read_only" => {
                    args.push("--agent".into());
                    args.push("plan".into());
                }
                _ => {}
            }
            if let Some(id) = &resume {
                args.push("-s".into());
                args.push(id.clone());
            }
            resolve_for_spawn(&CommandSpec {
                program: "opencode".into(),
                args,
            })
        }
    };

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // OpenCode only: point the CLI at the Conduit-owned opencode.json that
    // registers conduit-browser (it has no --mcp-config CLI flag).
    if matches!(kind, PerTurn::OpenCode) {
        // Bundle's opencode.json already has both MCP servers + permissions;
        // the legacy path only applies when the bundle failed to write.
        if let Some(cfg) = bundle.as_ref().map(|b| b.opencode_config.clone())
            .filter(|p| p.exists())
            .or(opencode_legacy_cfg.clone()) {
            cmd.env("OPENCODE_CONFIG", cfg);
        }
    }
    // Snapshot the spawn dir once for this turn so finish_turn can diff it
    // afterwards and surface files the CLI created as artifacts.
    let mut watch = None;
    if let Some(dir) = spawn_dir(cwd, &db.0) {
        cmd.current_dir(&dir);
        watch = Some(DirWatch::new(dir));
    }
    no_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {} CLI: {e}", spec.program))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture CLI stdout")?;
    entry.turn_in_flight.store(true, Ordering::SeqCst);
    entry.child = Some(child);
    // Fresh per-turn cancel flag: a reader thread from a cancelled turn must
    // keep seeing `true` even after the next send replaces the entry's flag.
    let cancelled = Arc::new(AtomicBool::new(false));
    entry.cancelled = Arc::clone(&cancelled);

    let app2 = app.clone();
    let db2 = DbState(Arc::clone(&db.0));
    let sid2 = sid.to_string();
    let in_flight2 = Arc::clone(&entry.turn_in_flight);
    let session_cell = Arc::clone(&entry.cli_session_id);
    let is_kimi = matches!(kind, PerTurn::Kimi);
    std::thread::spawn(move || {
        read_per_turn_stream(
            Some(&app2),
            &db2,
            &sid2,
            stdout,
            &in_flight2,
            &session_cell,
            is_kimi,
            &cancelled,
            watch,
        );
    });
    Ok(())
}

/// Reader loop for one-shot processes: parse events, then close the turn at
/// EOF (process exit). Usage is taken from the stream when the CLI reports
/// it; otherwise done carries nulls.
fn read_per_turn_stream(
    app: Option<&AppHandle>,
    db: &DbState,
    sid: &str,
    stdout: impl std::io::Read,
    in_flight: &AtomicBool,
    session_cell: &Arc<Mutex<Option<String>>>,
    is_kimi: bool,
    cancelled: &AtomicBool,
    mut watch: Option<DirWatch>,
) {
    let mut full = String::new();
    // OpenCode buffers deltas internally in `run` mode: each "text" event
    // carries the FULL snapshot of its part so far, not a delta. Track the
    // last snapshot so only the new suffix is emitted/persisted.
    let mut last_text = String::new();
    let mut input: Option<i64> = None;
    let mut output: Option<i64> = None;
    let mut cost: Option<f64> = None;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if is_kimi {
            handle_kimi_event(app, sid, &v, &mut full, session_cell, &mut input, &mut output);
        } else {
            handle_opencode_event(app, sid, &v, &mut full, session_cell, &mut input, &mut output, &mut cost, &mut last_text);
        }
    }
    // Process exit closes the turn. Persist any captured CLI session id so
    // the next turn (even after cancel or an app restart) resumes the same
    // conversation. If the turn was cancelled, discard the partial reply —
    // cancel() already emitted `chat:done`.
    persist_cli_session_id(db, if is_kimi { "kimi_code" } else { "opencode" }, sid, session_cell);
    in_flight.store(false, Ordering::SeqCst);
    if cancelled.load(Ordering::SeqCst) {
        full.clear();
    } else {
        finish_turn(app, db, sid, &mut full, input, output, cost, &mut watch);
    }
}

/// Kimi stream-json: `{"role":"assistant","content":…}` messages, tool events
/// (see tool_marker_kimi), and a `session.resume_hint` meta line carrying the
/// resume id. (Verified against v0.31.1 output.)
fn handle_kimi_event(
    app: Option<&AppHandle>,
    sid: &str,
    v: &Value,
    full: &mut String,
    session_cell: &Arc<Mutex<Option<String>>>,
    input: &mut Option<i64>,
    output: &mut Option<i64>,
) {
    let role = v.get("role").and_then(|r| r.as_str()).unwrap_or("");
    match role {
        "assistant" => {
            if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
                full.push_str(text);
                emit_token(app, sid, text);
            }
            // Tool calls ride along as structured blocks when present.
            if let Some(tools) = v.get("tool_calls").and_then(|t| t.as_array()) {
                for marker in tools.iter().filter_map(tool_marker_kimi) {
                    full.push_str(&marker);
                    emit_token(app, sid, &marker);
                }
            }
        }
        "tool" => {
            // Tool results carry no name field and the assistant narrates
            // the outcome anyway — rendering them would be noise. Skipped.
        }
        "meta" => {
            if v.get("type").and_then(|t| t.as_str()) == Some("session.resume_hint") {
                if let Some(id) = v.get("session_id").and_then(|s| s.as_str()) {
                    if let Ok(mut g) = session_cell.lock() {
                        *g = Some(id.to_string());
                    }
                }
            }
            if v.get("type").and_then(|t| t.as_str()) == Some("usage") {
                if let Some(u) = v.get("usage") {
                    *input = u.get("input_tokens").and_then(|t| t.as_i64()).or(*input);
                    *output = u.get("output_tokens").and_then(|t| t.as_i64()).or(*output);
                }
            }
        }
        _ => {}
    }
}

/// OpenCode `--format json` events. (Shapes verified against `opencode run`.)
fn handle_opencode_event(
    app: Option<&AppHandle>,
    sid: &str,
    v: &Value,
    full: &mut String,
    session_cell: &Arc<Mutex<Option<String>>>,
    input: &mut Option<i64>,
    output: &mut Option<i64>,
    cost: &mut Option<f64>,
    last_text: &mut String,
) {
    match v.get("type").and_then(|t| t.as_str()) {
        // {"type":"text","part":{"text":…}} — assistant text chunk. In `run`
        // mode opencode buffers deltas internally and fires one event per
        // completed text part with the FULL snapshot of that part's text, so
        // emit/append only the new suffix; a snapshot that doesn't extend the
        // previous one is a new part and is emitted whole. (Appending the
        // whole snapshot to `full` would duplicate it in the persisted
        // message.)
        Some("text") => {
            if let Some(text) = v.pointer("/part/text").and_then(|t| t.as_str()) {
                let suffix = text.strip_prefix(last_text.as_str()).unwrap_or(text);
                if !suffix.is_empty() {
                    full.push_str(suffix);
                    emit_token(app, sid, suffix);
                }
                last_text.clear();
                last_text.push_str(text);
            }
        }
        // {"type":"tool_use","part":{"tool":…,"state":{"input":…}}}
        Some("tool_use") => {
            let part = v.get("part").cloned().unwrap_or(json!({}));
            let name = part.get("tool").and_then(|t| t.as_str()).unwrap_or("tool");
            let inp = part.pointer("/state/input").cloned().unwrap_or(json!({}));
            let marker = format!("<tool>{}</tool>", tool_meta_generic(name, &inp));
            full.push_str(&marker);
            emit_token(app, sid, &marker);
        }
        // Session id / usage surfaces on step-finish.
        Some("step_finish") => {
            if let Ok(mut g) = session_cell.lock() {
                if g.is_none() {
                    if let Some(id) = v.get("sessionID").and_then(|s| s.as_str()) {
                        *g = Some(id.to_string());
                    }
                }
            }
            if let Some(u) = v.pointer("/part/tokens") {
                *input = u.get("input").and_then(|t| t.as_i64()).or(*input);
                *output = u.get("output").and_then(|t| t.as_i64()).or(*output);
            }
            // Free models report cost 0; Zen/relay models report real dollars.
            *cost = v.pointer("/part/cost").and_then(|c| c.as_f64()).or(*cost);
        }
        // Any event carrying the session id is a chance to capture it.
        _ => {
            if let Ok(mut g) = session_cell.lock() {
                if g.is_none() {
                    if let Some(id) = v.get("sessionID").and_then(|s| s.as_str()) {
                        *g = Some(id.to_string());
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- one-shot turns

/// Run a single self-contained turn and BLOCK until it finishes. This is the
/// shared engine for automations: the in-app scheduler calls it with
/// `Some(app)` (live `chat:*` events) and the headless `conduit-automation`
/// binary calls it with `None` (no Tauri runtime — events become no-ops,
/// messages still persist to the DB). Unlike the chat-session paths above,
/// claude runs one-shot here too (`claude -p <prompt>`), because scheduled
/// turns never need a persistent process or cross-turn CLI session resume.
pub fn run_one_shot(
    app: Option<&AppHandle>,
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    chat_session_id: &str,
    prompt: &str,
    harness: &str,
    model: &str,
    perm: &str,
    cwd: Option<&str>,
) -> Result<(), String> {
    {
        let conn = db.lock();
        crate::db::add_chat_message(&conn, chat_session_id, "user", prompt, None, None, None)
            .map_err(|e| e.to_string())?;
    }

    // Prepend the custom system prompt (same as the chat-session path).
    let effective = {
        let conn = db.lock();
        let custom: Option<String> =
            crate::db::get_setting(&conn, "assistant.systemPrompt").ok().flatten();
        match custom {
            Some(sp) if !sp.trim().is_empty() => {
                format!("{sp}\n\n---\n\n{prompt}")
            }
            _ => prompt.to_string(),
        }
    };

    let spec = one_shot_spec(harness, &effective, model, perm)?;
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Same artifact detection as the chat-session paths: diff the spawn dir
    // after the turn and surface created/modified files.
    let mut watch = None;
    if let Some(dir) = spawn_dir(cwd, db) {
        cmd.current_dir(&dir);
        watch = Some(DirWatch::new(dir));
    }
    no_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {} CLI: {e}", spec.program))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture CLI stdout")?;

    let db2 = DbState(Arc::clone(db));
    let sid2 = chat_session_id.to_string();
    let in_flight = Arc::new(AtomicBool::new(true));
    let in_flight2 = Arc::clone(&in_flight);
    let app2 = app.cloned();
    let is_claude = harness == "claude_code";
    let is_kimi = harness == "kimi_code";
    let reader = std::thread::spawn(move || {
        // One-shot turns are never cancelled (they block the caller) and never
        // resumed, so both cells are throwaway; the readers still persist any
        // captured id, which is harmless (keyed by harness + chat id).
        let never_cancelled = AtomicBool::new(false);
        if is_claude {
            let cell = Arc::new(Mutex::new(None));
            let dummy_stdin = Arc::new(Mutex::new(None));
            let dummy_approval = Arc::new(Mutex::new(None));
            read_claude_stream(app2.as_ref(), &db2, &sid2, stdout, &in_flight2, &cell, &never_cancelled, dummy_stdin, dummy_approval, watch);
        } else {
            let cell = Arc::new(Mutex::new(None));
            read_per_turn_stream(app2.as_ref(), &db2, &sid2, stdout, &in_flight2, &cell, is_kimi, &never_cancelled, watch);
        }
    });

    let wait = child.wait();
    let _ = reader.join();
    match wait {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("{} exited with {status}", spec.program)),
        Err(e) => Err(format!("failed to wait on {}: {e}", spec.program)),
    }
}

/// Build the spawn spec for a one-shot turn on any harness.
fn one_shot_spec(harness: &str, prompt: &str, model: &str, perm: &str) -> Result<CommandSpec, String> {
    let spec = match harness {
        "claude_code" => {
            let mut args: Vec<String> = vec![
                "-p".into(),
                prompt.into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--include-partial-messages".into(),
                "--permission-mode".into(),
                claude_permission_mode(perm).into(),
            ];
            if !model.is_empty() {
                args.push("--model".into());
                args.push(claude_model_alias(model));
            }
            CommandSpec { program: "claude".into(), args }
        }
        "kimi_code" => {
            let mut args: Vec<String> = vec![
                "-p".into(),
                prompt.into(),
                "--output-format".into(),
                "stream-json".into(),
            ];
            if !model.is_empty() {
                args.push("-m".into());
                args.push(model.into());
            }
            CommandSpec { program: "kimi".into(), args }
        }
        "opencode" => {
            let mut args: Vec<String> = vec!["run".into(), "--".into(), prompt.into(), "--format".into(), "json".into()];
            if !model.is_empty() {
                args.push("-m".into());
                args.push(model.into());
            }
            match perm {
                "full_auto" => args.push("--auto".into()),
                "read_only" => {
                    args.push("--agent".into());
                    args.push("plan".into());
                }
                _ => {}
            }
            CommandSpec { program: "opencode".into(), args }
        }
        other => return Err(format!("harness '{other}' has no headless chat backend yet")),
    };
    Ok(resolve_for_spawn(&spec))
}

// ---------------------------------------------------------------- tool markers

/// A tool's own content must never contain the closing tag or it would
/// truncate the marker on the client (same defense as chat/proto.rs).
fn sanitize(v: String) -> String {
    v.replace("</tool>", "<\\/tool>")
}

/// Claude Code tool_use block → `<tool>{json}</tool>` marker (same shapes as
/// chat/proto.rs `tool_block` so DiffCard/activity groups just work).
fn tool_marker_claude(block: &Value) -> Option<String> {
    let name = block.get("name").and_then(|n| n.as_str())?;
    let input = block.get("input").cloned().unwrap_or(json!({}));
    // One marker per MultiEdit hunk so each gets its own DiffCard.
    if name == "MultiEdit" {
        let path = input.get("file_path").and_then(|p| p.as_str()).unwrap_or("");
        let edits = input.get("edits").and_then(|e| e.as_array()).cloned().unwrap_or_default();
        return Some(
            edits
                .iter()
                .map(|e| {
                    json!({
                        "kind": "edit",
                        "title": format!("Editing file \"{path}\""),
                        "detail": path,
                        "path": path,
                        "edit": {
                            "mode": "replace",
                            "find": sanitize(e.get("old_string").and_then(|v| v.as_str()).unwrap_or("").to_string()),
                            "replace": sanitize(e.get("new_string").and_then(|v| v.as_str()).unwrap_or("").to_string()),
                        },
                    })
                })
                .map(|m| format!("<tool>{m}</tool>"))
                .collect::<Vec<_>>()
                .join(""),
        );
    }
    Some(format!("<tool>{}</tool>", tool_meta_generic(name, &input)))
}

/// Kimi tool_call object → marker. Kimi names tools close to Claude's
/// (Edit/Write/Read/Bash/Grep/Glob…) with args under `function.arguments`
/// (JSON string) or directly as input — both handled.
fn tool_marker_kimi(call: &Value) -> Option<String> {
    let func = call.get("function").cloned().unwrap_or(call.clone());
    let name = func.get("name").and_then(|n| n.as_str())?.to_string();
    let args = match func.get("arguments") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(json!({})),
        Some(v) => v.clone(),
        None => json!({}),
    };
    Some(format!("<tool>{}</tool>", tool_meta_generic(&name, &args)))
}

/// Shared tool-name → marker-meta mapping across CLIs. Claude, Kimi and
/// OpenCode all converge on similar tool names; the edit-shaped tools map to
/// DiffCard payloads, everything else to activity-group steps.
fn tool_meta_generic(name: &str, input: &Value) -> Value {
    let s = |k: &str| {
        input
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    // Normalize the common aliases the CLIs use for file edits.
    let lname = name.to_lowercase();
    let is_edit = matches!(lname.as_str(), "edit" | "edit_file" | "multiedit" | "str_replace_editor");
    let is_write = matches!(lname.as_str(), "write" | "write_file" | "create_file");
    let is_shell = matches!(lname.as_str(), "bash" | "shell" | "run_shell" | "run_command");

    if is_edit {
        let path = if s("file_path").is_empty() { s("path") } else { s("file_path") };
        let find = if s("old_string").is_empty() { s("find") } else { s("old_string") };
        let replace = if s("new_string").is_empty() { s("replace") } else { s("new_string") };
        json!({
            "kind": "edit",
            "title": format!("Editing file \"{path}\""),
            "detail": path,
            "path": path,
            "edit": { "mode": "replace", "find": sanitize(find), "replace": sanitize(replace) },
        })
    } else if is_write {
        let path = if s("file_path").is_empty() { s("path") } else { s("file_path") };
        json!({
            "kind": "edit",
            "title": format!("Writing file \"{path}\""),
            "detail": path,
            "path": path,
            "edit": { "mode": "write", "content": sanitize(s("content")) },
        })
    } else if is_shell {
        let cmd = if s("command").is_empty() { s("cmd") } else { s("command") };
        json!({ "kind": "code", "title": "Running shell command", "lang": "bash", "code": sanitize(cmd) })
    } else {
        match name {
            "Read" | "read" | "read_file" => json!({ "kind": "tool", "title": "Reading file", "detail": if s("file_path").is_empty() { s("path") } else { s("file_path") } }),
            "Grep" | "grep" => json!({ "kind": "search", "title": "Searching code", "detail": s("pattern") }),
            "Glob" | "glob" => json!({ "kind": "search", "title": "Finding files", "detail": s("pattern") }),
            "WebSearch" | "web_search" => json!({ "kind": "search", "title": "Searching the web", "detail": s("query") }),
            "WebFetch" | "web_fetch" | "fetch_url" => json!({ "kind": "web", "title": "Reading a web page", "detail": s("url") }),
            "TodoWrite" | "todowrite" => json!({ "kind": "tool", "title": "Updating task list" }),
            "Task" | "task" => json!({ "kind": "tool", "title": "Running subagent", "detail": s("description") }),
            _ => json!({ "kind": "tool", "title": format!("Running tool {name}") }),
        }
    }
}

// ---------------------------------------------------------------- shared emit/persist

/// Turn finished successfully: persist the accumulated assistant message
/// (mirroring the built-in chat, so onDone's refetch sees it), surface any
/// files the CLI created or modified as artifacts (same insert_artifact +
/// `chat:artifact` emit as the built-in chat in chat/dispatch.rs), then emit
/// done.
fn finish_turn(
    app: Option<&AppHandle>,
    db: &DbState,
    sid: &str,
    full: &mut String,
    input: Option<i64>,
    output: Option<i64>,
    cost: Option<f64>,
    watch: &mut Option<DirWatch>,
) {
    // Persist the assistant message FIRST so we can attribute artifacts to it.
    let message_id: Option<i64> = if !full.is_empty() {
        let conn = db.0.lock();
        crate::db::add_chat_message(&conn, sid, "assistant", full, input, output, cost)
            .ok()
            .map(|m| m.id)
    } else {
        None
    };
    full.clear();

    if let Some(w) = watch.as_mut() {
        let after = snapshot_dir(&w.dir);
        let changed = changed_previewable_files(&w.before, &after);
        // Refresh the baseline so the next turn (claude's persistent process
        // runs many turns against one reader) reports only its own files.
        w.before = after;
        for rel in changed {
            let path = w.dir.join(&rel).to_string_lossy().to_string();
            let filename = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            let kind = Path::new(&filename)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            {
                let conn = db.0.lock();
                let _ = crate::db::insert_artifact(&conn, Some(sid), &filename, &path, &kind);
            }
            if let Some(app) = app {
                let _ = app.emit(
                    "chat:artifact",
                    crate::types::ChatArtifactPayload {
                        chat_session_id: sid.to_string(),
                        path,
                        filename,
                    },
                );
            }
        }
    }

    // Attribute this turn's artifacts to the assistant message so they
    // reappear on its bubble when the chat is reopened (mirrors chat/mod.rs).
    if let Some(mid) = message_id {
        let conn = db.0.lock();
        let _ = crate::db::attach_artifacts_to_message(&conn, sid, mid);
    }

    emit_done(app, sid, input, output, cost);
}

fn emit_token(app: Option<&AppHandle>, sid: &str, token: &str) {
    if let Some(app) = app {
        let _ = app.emit("chat:token", json!({ "chatSessionId": sid, "token": token }));
    }
}

fn emit_done(app: Option<&AppHandle>, sid: &str, input: Option<i64>, output: Option<i64>, cost: Option<f64>) {
    if let Some(app) = app {
        let _ = app.emit(
            "chat:done",
            json!({ "chatSessionId": sid, "inputTokens": input, "outputTokens": output, "costUsd": cost }),
        );
    }
}

fn emit_error(app: Option<&AppHandle>, sid: &str, message: &str) {
    if let Some(app) = app {
        let _ = app.emit(
            "chat:error",
            json!({ "chatSessionId": sid, "message": message, "code": null }),
        );
    }
}

/// A GUI app spawning console tools on Windows would otherwise flash a
/// console window per spawn.
fn no_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// OpenCode "text" events carry the full snapshot of a part's text, not a
    /// delta: only the new suffix must reach `full`/the token stream, and a
    /// non-extending snapshot starts a new part (emitted whole).
    #[test]
    fn opencode_text_events_emit_only_new_suffix() {
        let cell = Arc::new(Mutex::new(None));
        let mut full = String::new();
        let mut last = String::new();
        let (mut input, mut output, mut cost) = (None, None, None);
        let ev = |t: &str| json!({ "type": "text", "part": { "text": t } });
        let mut feed = |v: &Value, full: &mut String, last: &mut String| {
            handle_opencode_event(None, "s", v, full, &cell, &mut input, &mut output, &mut cost, last);
        };
        feed(&ev("Hello"), &mut full, &mut last);
        feed(&ev("Hello, world"), &mut full, &mut last);
        assert_eq!(full, "Hello, world");
        feed(&ev("Hello, world!"), &mut full, &mut last);
        assert_eq!(full, "Hello, world!");
        // A snapshot that doesn't extend the previous one is a new part.
        feed(&ev("Next part"), &mut full, &mut last);
        assert_eq!(full, "Hello, world!Next part");
    }

    /// The dir diff reports NEW and MODIFIED files with previewable
    /// extensions only: unchanged files, unsupported extensions and skipped
    /// dirs (node_modules, hidden) never surface.
    #[test]
    fn dir_diff_detects_new_and_modified_previewable_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("keep.txt"), "v1").unwrap();
        std::fs::write(dir.join("notes.bin"), "x").unwrap();
        let before = snapshot_dir(dir);

        std::fs::write(dir.join("keep.txt"), "v1-longer").unwrap(); // modified
        std::fs::write(dir.join("notes.bin"), "xxx").unwrap(); // modified, unsupported ext
        std::fs::write(dir.join("report.md"), "# hi").unwrap(); // new
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/data.csv"), "a,b").unwrap(); // new, nested
        std::fs::create_dir_all(dir.join("node_modules/dep")).unwrap();
        std::fs::write(dir.join("node_modules/dep/index.js"), "1").unwrap(); // skipped dir
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join(".hidden/secret.md"), "s").unwrap(); // hidden dir

        let after = snapshot_dir(dir);
        assert_eq!(
            changed_previewable_files(&before, &after),
            vec![
                "keep.txt".to_string(),
                "report.md".to_string(),
                "sub/data.csv".to_string(),
            ]
        );
        // Diffing an unchanged tree reports nothing.
        let again = snapshot_dir(dir);
        assert!(changed_previewable_files(&after, &again).is_empty());
    }
}
