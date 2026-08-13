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

use std::collections::{BTreeMap, HashMap, VecDeque};
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

struct AgentChild {
    harness: String,
    /// Model the session was last spawned with — a model change respawns
    /// (claude) or just applies to the next per-turn process.
    model: String,
    /// claude_code: the persistent process (always Some).
    /// kimi/opencode: Some only while a turn's process is running.
    child: Option<Child>,
    /// claude_code: the model the persistent process was spawned with —
    /// a change kills and respawns it.
    spawned_model: Option<String>,
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
    /// Shared stdin for writing user input (e.g. a tool result) from the reader thread
    /// on stdin.
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
}

impl AgentSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Send one user turn. The harness id comes from the chat session's
    /// `agent` field ("harness:<id>"), passed by the command layer.
    /// `connectors` is the command layer's snapshot of connected connectors
    /// (tokens already refreshed), merged into the spawn's MCP config.
    pub fn send(
        &self,
        app: &AppHandle,
        db: &DbState,
        chat_session_id: &str,
        content: &str,
        harness: &str,
        model: &str,
        cwd: Option<&str>,
        project_id: Option<&str>,
        connectors: &[crate::connectors::HarnessMcpServer],
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
                    child: None,
                    spawned_model: None,
                    cli_session_id: Arc::new(Mutex::new(stored)),
                    turn_in_flight: Arc::new(AtomicBool::new(false)),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    stdin: Arc::new(Mutex::new(None)),
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

        // Mirror the built-in chat: the user message is persisted up front so
        // history survives a crash mid-turn. Done AFTER the turn-in-flight
        // check so a rejected turn can't orphan a user message.
        {
            let conn = db.0.lock();
            crate::db::add_chat_message(&conn, chat_session_id, "user", content, None, None, None, None, None, None, None, None, None, None, None)
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
            "claude_code" => send_claude_turn(app, db, chat_session_id, &effective, entry, cwd, project_id, connectors),
            "kimi_code" => spawn_per_turn(app, db, chat_session_id, &effective, entry, cwd, project_id, PerTurn::Kimi, connectors),
            "opencode" => spawn_per_turn(app, db, chat_session_id, &effective, entry, cwd, project_id, PerTurn::OpenCode, connectors),
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

/// Registry of one-shot (automation) children so the app-exit handler can
/// kill them (M13): `run_one_shot` spawns a full `--dangerously-skip-permissions`
/// CLI tree that is NOT in the session registry — without this it keeps
/// running after the app quits. Keyed by pid; entries are removed when the
/// child is reaped, and the kill path skips children that already exited, so
/// a recycled pid can never be hit. BTreeMap only because `BTreeMap::new` is
/// const (HashMap's RandomState isn't).
static ONE_SHOT_CHILDREN: Mutex<BTreeMap<u32, Arc<Mutex<Child>>>> =
    Mutex::new(BTreeMap::new());

fn register_one_shot_child(child: &Arc<Mutex<Child>>) -> Option<u32> {
    let pid = child.lock().ok()?.id();
    ONE_SHOT_CHILDREN.lock().ok()?.insert(pid, Arc::clone(child));
    Some(pid)
}

fn unregister_one_shot_child(pid: u32) {
    if let Ok(mut map) = ONE_SHOT_CHILDREN.lock() {
        map.remove(&pid);
    }
}

/// Kill every registered one-shot child (app shutdown). Idempotent; children
/// that already exited are skipped — their pid may have been recycled, and
/// `try_wait` is the only safe way to know the handle is still ours.
pub fn kill_one_shot_children() {
    let drained: Vec<Arc<Mutex<Child>>> = match ONE_SHOT_CHILDREN.lock() {
        Ok(mut map) => std::mem::take(&mut *map).into_values().collect(),
        Err(_) => return,
    };
    for child in drained {
        if let Ok(mut guard) = child.lock() {
            let already_exited = matches!(guard.try_wait(), Ok(Some(_)) | Err(_));
            if !already_exited {
                kill_child_tree(&mut guard);
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
    connectors: &[crate::connectors::HarnessMcpServer],
) -> Result<(), String> {
    if entry.child.is_none() || entry.spawned_model.as_deref() != Some(entry.model.as_str()) {
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
            cwd,
            project_id,
            &entry.turn_in_flight,
            &entry.cli_session_id,
            &cancelled,
            &entry.stdin,
            connectors,
        )?);
        entry.spawned_model = Some(entry.model.clone());
    }

    let line = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": content }],
        },
    })
    .to_string();
    // Set turn_in_flight BEFORE the stdin write (mirrors spawn_per_turn): the
    // reader thread can see this turn's `result`/EOF and clear the flag in
    // the gap between write and store — the trailing store would then re-set
    // a flag the reader already cleared, wedging every future send with
    // "turn already running". The flag can only legitimately transition
    // true→false from a result arriving, which requires the write first.
    entry.turn_in_flight.store(true, Ordering::SeqCst);
    let write_result = {
        let mut guard = entry.stdin.lock().map_err(|e| e.to_string())?;
        let stdin = guard.as_mut().ok_or("agent process stdin is closed")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
    };
    if let Err(e) = write_result {
        // The turn never reached the CLI — undo the flag we just set so the
        // next send isn't blocked by a phantom in-flight turn.
        entry.turn_in_flight.store(false, Ordering::SeqCst);
        return Err(format!("failed to write to CLI stdin: {e}"));
    }
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

/// Directories a harness turn's artifact diff must watch: the spawn dir
/// (files the CLI writes into its workspace) PLUS the artifacts dir
/// (files the conduit-tools MCP writes — mcp_tools_bridge always resolves
/// `dispatch::artifacts_dir`, which differs from the spawn dir whenever a
/// project is selected or the user configured a custom `storage.artifactsDir`).
/// Watching only the spawn dir silently drops every MCP-generated docx/pptx/
/// pdf: no artifact row, no `chat:artifact` event, no canvas auto-open.
/// Deduped (canonicalized); spawn dir first.
fn turn_watch_dirs(
    cwd: Option<&str>,
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = spawn_dir(cwd, db) {
        dirs.push(d);
    }
    // Mirror dispatch::artifacts_dir's default without needing an AppHandle:
    // configured dir, else <Documents>/Conduit (falling back to home).
    let artifacts = {
        let conn = db.lock();
        crate::chat::dispatch::configured_artifacts_dir(&conn)
    }
    .or_else(|| {
        dirs::document_dir()
            .or_else(dirs::home_dir)
            .map(|base| base.join("Conduit"))
    });
    if let Some(a) = artifacts {
        let _ = std::fs::create_dir_all(&a);
        let canon = |p: &PathBuf| std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
        let a_canon = canon(&a);
        if !dirs.iter().any(|d| canon(d) == a_canon) {
            dirs.push(a);
        }
    }
    dirs
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

/// Bundle slug for sessions with no selected project. Connectors and
/// conduit-tools work project-less too, so a bundle is always written; the
/// tradeoff is that browser panes and artifacts of ALL project-less sessions
/// share this one scope.
const NO_PROJECT_BUNDLE_SLUG: &str = "_no_project";

/// Resolve (write if needed) the per-project harness bundle. Project-less
/// sessions fall back to the `_no_project` slug so connectors + conduit-tools
/// still reach the CLI. Returns None only when the app data dir or the write
/// fails — bundle failure must never fail the turn (same contract as the old
/// resolve_mcp_config). `connectors` are merged into the bundle's MCP configs
/// as remote servers (tokens already refreshed by the command layer).
fn resolve_harness_bundle(
    app: &AppHandle,
    project_id: Option<&str>,
    cwd: Option<&str>,
    artifacts_dir: String,
    connectors: &[crate::connectors::HarnessMcpServer],
) -> Option<crate::harness_bundle::HarnessBundlePaths> {
    let data_dir = app.path().app_data_dir().ok()?;
    crate::harness_bundle::write_bundle(
        &data_dir, project_id.unwrap_or(NO_PROJECT_BUNDLE_SLUG), cwd, Some(artifacts_dir.as_str()), None, crate::browser::BROWSER_MCP_PORT, connectors)
}

fn spawn_claude(
    app: &AppHandle,
    db: &DbState,
    sid: &str,
    model: &str,
    cwd: Option<&str>,
    project_id: Option<&str>,
    in_flight: &Arc<AtomicBool>,
    session_cell: &Arc<Mutex<Option<String>>>,
    cancelled: &Arc<AtomicBool>,
    shared_stdin: &Arc<Mutex<Option<std::process::ChildStdin>>>,
    connectors: &[crate::connectors::HarnessMcpServer],
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
        "--dangerously-skip-permissions".into(),
        "--model".into(),
        alias,
    ];
    // Respawning (after a cancel, model change, or app restart) would
    // start a blank conversation — resume the captured CLI session instead.
    let resume = session_cell.lock().ok().and_then(|g| g.clone());
    if let Some(id) = &resume {
        args.push("--resume".into());
        args.push(id.clone());
    }
    // Conduit-owned bundle: instructions, permissions, and both MCP servers
    // (browser + tools). Registration failure degrades to no extra flags —
    // the turn still runs, just without conduit's prompt/tools.
    if let Some(bundle) = resolve_harness_bundle(app, project_id, cwd, artifacts_dir_for_bundle(app, cwd), connectors) {
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
    // Snapshot the watch dirs once per (re)spawn so finish_turn can diff them
    // after each turn and surface files the CLI created as artifacts. The
    // first dir is the spawn dir (the CLI's workspace); the second (when
    // different) is the artifacts dir conduit-tools MCP writes into.
    let watch_dirs = turn_watch_dirs(cwd, &db.0);
    if let Some(dir) = watch_dirs.first() {
        cmd.current_dir(dir);
    }
    let mut watches: Vec<DirWatch> = watch_dirs.into_iter().map(DirWatch::new).collect();
    no_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn claude CLI: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture claude stdout")?;
    // Take stdin and share it so the reader thread can write user input
    // (e.g. a tool result) on stdin.
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
            watches,
        );
    });
    Ok(child)
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
    mut watches: Vec<DirWatch>,
) {
    let mut full = String::new();
    // Capture the turn's start instant for the "Worked for Xs" label. The
    // reader is invoked right after the prompt is sent to the persistent CLI,
    // so this is a close lower bound on the turn's wall-clock window.
    let started_at = crate::db::now_ts();
    // Whether a thinking block is currently streaming: thinking deltas are
    // wrapped in `<think>…</think>` markers (the frontend renders them as a
    // collapsible block), mirroring anthropic_stream_round in
    // chat/streaming.rs.
    let mut in_think = false;
    // Matches each tool RESULT back to its call so shell output can be attached
    // to the originating step. Lives across the loop; the pending queue drains
    // within each turn (every call gets its result before the turn's `result`).
    let mut tools = ToolTracker::new();
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
                    // Tool-use content_block_start: extract tool markers for
                    // the frontend's tool-call cards. No permission relay —
                    // the CLI is spawned with --dangerously-skip-permissions,
                    // so no stdin approval is needed.
                    Some("content_block_start") => {
                        let block = delta
                            .and_then(|d| d.get("content_block"))
                            .or_else(|| v.pointer("/event/content_block"));
                        if let Some(block) = block {
                            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                // No relay needed — full-auto mode.
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
                    // No safety-net relay — CLI is in full-auto mode (no stdin
                    // approval). Just extract tool markers for the UI.
                    for b in blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
                    {
                        if let Some((name, values)) = tool_meta_claude(b) {
                            let marker = tools.tool_use(&name, values);
                            full.push_str(&marker);
                            emit_token(app, sid, &marker);
                        }
                    }
                }
            }
            // Tool results come back as user-role messages whose content is an
            // array of tool_result blocks (in tool_use order). Attach shell
            // output to its step; other tools are tracked only for ordering.
            Some("user") => {
                if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                    for r in blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                    {
                        let is_error = r
                            .get("is_error")
                            .and_then(|e| e.as_bool())
                            .unwrap_or(false);
                        let text = extract_result_text(r.get("content"));
                        if let Some(marker) = tools.tool_result(&text, is_error) {
                            full.push_str(&marker);
                            emit_token(app, sid, &marker);
                        }
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
                    finish_turn(app, db, sid, &mut full, input, output, cost, &mut watches, started_at);
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
    connectors: &[crate::connectors::HarnessMcpServer],
) -> Result<(), String> {
    let resume = entry.cli_session_id.lock().ok().and_then(|g| g.clone());
    // Conduit-owned bundle: instructions, permissions, and MCP registration.
    // Failure degrades to the legacy browser-only configs below (or none).
    // The bundle hardcodes bypassPermissions in settings.json so claude
    // runs with full-auto approval.
    let bundle = resolve_harness_bundle(app, project_id, cwd, artifacts_dir_for_bundle(app, cwd), connectors);
    // Legacy fallback: browser-only MCP when the bundle (or its mcp part)
    // didn't write — keeps pty-style browser tools working in degraded mode.
    let opencode_legacy_cfg = if bundle.is_none() {
        resolve_opencode_config(app, project_id)
    } else {
        None
    };
    let mut prompt_env: Option<(String, String)> = None;
    let spec = match kind {
        PerTurn::Kimi => {
            // The untrusted prompt never rides the command line — it goes via
            // CONDUIT_TURN_PROMPT + a delayed-expansion wrapper batch on
            // Windows (M12, see harness_adapters::turn_spec). Only OUR
            // bounded strings (model, session id, bundle paths) are argv.
            // Kimi prompt mode is non-interactive; --yolo/--auto are
            // interactive-mode flags that kimi rejects with -p.
            // Tool calls are auto-approved by default in prompt mode.
            let mut flags: Vec<String> = vec![
                "--output-format".into(),
                "stream-json".into(),
            ];
            if !entry.model.is_empty() {
                flags.push("-m".into());
                flags.push(entry.model.clone());
            }
            if let Some(id) = &resume {
                // Verified against `kimi --help` (v0.31): `-S, --session <id>`.
                flags.push("--session".into());
                flags.push(id.clone());
            }
            // Bundle args cover --mcp-config-file, --agent-file (fresh only),
            // and --add-dir. kimi_bundle_args skips --agent-file when resuming
            // (kimi forbids it with --session). When bundle is None, nothing is
            // added — matching today's degraded behavior (no browser tools).
            if let Some(b) = &bundle {
                flags.extend(crate::harness_bundle::kimi_bundle_args(
                    b, &artifacts_dir_for_bundle(app, cwd), resume.is_some()));
            }
            let (spec, env) =
                crate::harness_adapters::turn_spec(crate::harness_adapters::TurnHarness::Kimi, content, flags);
            prompt_env = env;
            spec
        }
        PerTurn::OpenCode => {
            // Every flag must come BEFORE the `--` terminator: yargs (which
            // `opencode run` uses) treats post-`--` tokens as positional
            // message parts — turn_spec's argv/wrapper assembly keeps that
            // invariant. Only the prompt is positional, and on Windows it
            // arrives via the wrapper's delayed-expansion env read (M12).
            let mut flags: Vec<String> = vec![];
            if !entry.model.is_empty() {
                flags.push("-m".into());
                flags.push(entry.model.clone());
            }
            // OpenCode: --auto is baked into the wrapper/argv prefix.
            if let Some(id) = &resume {
                flags.push("-s".into());
                flags.push(id.clone());
            }
            let (spec, env) =
                crate::harness_adapters::turn_spec(crate::harness_adapters::TurnHarness::OpenCode, content, flags);
            prompt_env = env;
            spec
        }
    };

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // The prompt travels in the process env block (never cmd-parsed) when the
    // Windows wrapper transport is active — see turn_spec.
    if let Some((k, v)) = &prompt_env {
        cmd.env(k, v);
    }
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
    // Snapshot the watch dirs once for this turn so finish_turn can diff them
    // afterwards and surface files the CLI created as artifacts (spawn dir +
    // the artifacts dir conduit-tools MCP writes into, when different).
    let watch_dirs = turn_watch_dirs(cwd, &db.0);
    if let Some(dir) = watch_dirs.first() {
        cmd.current_dir(dir);
    }
    let watches: Vec<DirWatch> = watch_dirs.into_iter().map(DirWatch::new).collect();
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
            watches,
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
    mut watches: Vec<DirWatch>,
) {
    let mut full = String::new();
    // Capture the turn's start instant for the "Worked for Xs" label.
    let started_at = crate::db::now_ts();
    // OpenCode buffers deltas internally in `run` mode: each "text" event
    // carries the FULL snapshot of its part so far, not a delta. Track the
    // last snapshot so only the new suffix is emitted/persisted.
    let mut last_text = String::new();
    let mut input: Option<i64> = None;
    let mut output: Option<i64> = None;
    let mut cost: Option<f64> = None;
    let mut tools = ToolTracker::new();
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if is_kimi {
            handle_kimi_event(app, sid, &v, &mut full, session_cell, &mut input, &mut output, &mut tools);
        } else {
            handle_opencode_event(app, sid, &v, &mut full, session_cell, &mut input, &mut output, &mut cost, &mut last_text, &mut tools);
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
        finish_turn(app, db, sid, &mut full, input, output, cost, &mut watches, started_at);
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
    tools: &mut ToolTracker,
) {
    let role = v.get("role").and_then(|r| r.as_str()).unwrap_or("");
    match role {
        "assistant" => {
            if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
                full.push_str(text);
                emit_token(app, sid, text);
            }
            // Tool calls ride along as structured blocks when present.
            if let Some(calls) = v.get("tool_calls").and_then(|t| t.as_array()) {
                for c in calls.iter() {
                    if let Some((name, values)) = tool_meta_kimi(c) {
                        let marker = tools.tool_use(&name, values);
                        full.push_str(&marker);
                        emit_token(app, sid, &marker);
                    }
                }
            }
        }
        // Tool results: kimi delivers one per call, in call order. Attach shell
        // output to its step; non-shell results are consumed for ordering only.
        "tool" => {
            let text = extract_result_text(v.get("content"));
            if let Some(marker) = tools.tool_result(&text, false) {
                full.push_str(&marker);
                emit_token(app, sid, &marker);
            }
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
    tools: &mut ToolTracker,
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
            // Parse TodoWrite JSON to emit structured plan-step progress events.
            // This lets the frontend track individual task items with status
            // instead of seeing a generic "Updating task list" marker.
            if name.eq_ignore_ascii_case("TodoWrite") {
                if let Some(todos) = inp.get("todos").and_then(|v| v.as_array()) {
                    for todo in todos {
                        let content = todo.get("content")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let status = todo.get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("pending");
                        if !content.is_empty() {
                            if let Some(app_handle) = app {
                                crate::chat::tasks::emit_plan_step_progress(
                                    app_handle, sid, content, status, None, None::<&str>,
                                );
                            }
                        }
                    }
                }
            }
            let value = tool_meta_generic(name, &inp);
            // OpenCode reports a tool's completed output inline on the same
            // part (`state.output` / `state.error`); attach it for shell tools.
            let out_text = part.pointer("/state/output").and_then(|o| o.as_str());
            let err_text = part.pointer("/state/error").and_then(|e| e.as_str());
            let marker = tools.tool_use_with_output(name, value, out_text, err_text);
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
    cwd: Option<&str>,
) -> Result<(), String> {
    {
        let conn = db.lock();
        crate::db::add_chat_message(&conn, chat_session_id, "user", prompt, None, None, None, None, None, None, None, None, None, None, None)
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

    let (spec, prompt_env) = one_shot_spec(harness, &effective, model)?;
    // claude one-shot takes the prompt via stdin (see one_shot_spec — M12);
    // the other harnesses either carry it in the env pair (Windows wrapper)
    // or inline in argv (POSIX).
    let prompt_via_stdin = harness == "claude_code";
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(if prompt_via_stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some((k, v)) = &prompt_env {
        cmd.env(k, v);
    }
    // Same artifact detection as the chat-session paths: diff the watch dirs
    // (spawn dir + artifacts dir) after the turn and surface created/modified
    // files.
    let watch_dirs = turn_watch_dirs(cwd, db);
    if let Some(dir) = watch_dirs.first() {
        cmd.current_dir(dir);
    }
    let watches: Vec<DirWatch> = watch_dirs.into_iter().map(DirWatch::new).collect();
    no_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {} CLI: {e}", spec.program))?;
    if prompt_via_stdin {
        // Write the prompt and close the pipe — EOF tells the CLI the prompt
        // is complete. A write failure must kill the child, otherwise the
        // CLI waits on stdin forever and the automation turn hangs.
        let write_result = match child.stdin.take() {
            Some(mut stdin) => {
                use std::io::Write as _;
                stdin
                    .write_all(effective.as_bytes())
                    .and_then(|_| stdin.flush())
                    .map_err(|e| format!("failed to write prompt to CLI stdin: {e}"))
                // stdin drops here, closing the pipe.
            }
            None => Err("failed to open CLI stdin".to_string()),
        };
        if let Err(e) = write_result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    }
    // Register the child so the app-exit handler can kill this tree (M13):
    // an automation child is a full skip-permissions CLI tree that would
    // otherwise keep running after the app quits.
    let child = Arc::new(Mutex::new(child));
    let one_shot_pid = register_one_shot_child(&child);
    let stdout = {
        let mut guard = child.lock().map_err(|e| e.to_string())?;
        guard
            .stdout
            .take()
            .ok_or("failed to capture CLI stdout")?
    };

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
            read_claude_stream(app2.as_ref(), &db2, &sid2, stdout, &in_flight2, &cell, &never_cancelled, dummy_stdin, watches);
        } else {
            let cell = Arc::new(Mutex::new(None));
            read_per_turn_stream(app2.as_ref(), &db2, &sid2, stdout, &in_flight2, &cell, is_kimi, &never_cancelled, watches);
        }
    });

    // Poll-wait WITHOUT holding the child lock across the wait: the app-exit
    // handler must be able to lock + kill this child while we block (M13) —
    // holding it would deadlock the exit path against the running turn.
    let wait = loop {
        {
            let mut guard = match child.lock() {
                Ok(g) => g,
                Err(e) => {
                    break Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        e.to_string(),
                    ))
                }
            };
            match guard.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {}
                Err(e) => break Err(e),
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let _ = reader.join();
    if let Some(pid) = one_shot_pid {
        unregister_one_shot_child(pid);
    }
    match wait {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("{} exited with {status}", spec.program)),
        Err(e) => Err(format!("failed to wait on {}: {e}", spec.program)),
    }
}

/// Build the spawn spec for a one-shot turn on any harness. Always full-auto
/// (--dangerously-skip-permissions for claude, --auto for opencode — no
/// permission selector is surfaced or consulted in the UI, so all CLI turns
/// run unrestricted). Kimi prompt mode is already non-interactive and
/// auto-approves tool calls by default; --yolo/--auto are interactive-mode
/// flags that kimi rejects with -p.
///
/// The prompt is UNTRUSTED user text and never rides a cmd.exe command line
/// (M12): claude reads it from stdin (`claude -p` with no prompt arg — the
/// caller pipes it, see `prompt_via_stdin` in run_one_shot); kimi/opencode
/// get it via CONDUIT_TURN_PROMPT + delayed-expansion wrapper (the returned
/// env pair, Windows only — POSIX keeps the prompt in argv, which exec
/// carries verbatim).
fn one_shot_spec(harness: &str, prompt: &str, model: &str) -> Result<(CommandSpec, Option<(String, String)>), String> {
    match harness {
        "claude_code" => {
            let mut args: Vec<String> = vec![
                "-p".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--include-partial-messages".into(),
                "--dangerously-skip-permissions".into(),
            ];
            if !model.is_empty() {
                args.push("--model".into());
                args.push(claude_model_alias(model));
            }
            Ok((
                resolve_for_spawn(&CommandSpec {
                    program: "claude".into(),
                    args,
                }),
                None,
            ))
        }
        "kimi_code" => {
            let mut flags: Vec<String> = vec![
                "--output-format".into(),
                "stream-json".into(),
            ];
            if !model.is_empty() {
                flags.push("-m".into());
                flags.push(model.into());
            }
            Ok(crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::Kimi,
                prompt,
                flags,
            ))
        }
        "opencode" => {
            // Flags BEFORE `--` (yargs swallows post-terminator tokens into
            // the prompt — see spawn_per_turn's OpenCode arm); turn_spec's
            // assembly preserves that invariant.
            let mut flags: Vec<String> = vec![];
            if !model.is_empty() {
                flags.push("-m".into());
                flags.push(model.into());
            }
            Ok(crate::harness_adapters::turn_spec(
                crate::harness_adapters::TurnHarness::OpenCode,
                prompt,
                flags,
            ))
        }
        other => Err(format!("harness '{other}' has no headless chat backend yet")),
    }
}

// ---------------------------------------------------------------- tool markers

/// A tool's own content must never contain the closing tag or it would
/// truncate the marker on the client (same defense as chat/proto.rs).
fn sanitize(v: String) -> String {
    v.replace("</tool>", "<\\/tool>")
}

/// Claude Code tool_use block → `<tool>{json}</tool>` marker (same shapes as
/// chat/proto.rs `tool_block` so DiffCard/activity groups just work).
///
/// Returns the tool NAME plus the marker Value(s) (MultiEdit yields one per
/// hunk). The caller wraps them via `ToolTracker::tool_use`, which injects a
/// correlation id into shell markers and records the call so its later result
/// can be attached.
fn tool_meta_claude(block: &Value) -> Option<(String, Vec<Value>)> {
    let name = block.get("name").and_then(|n| n.as_str())?.to_string();
    let input = block.get("input").cloned().unwrap_or(json!({}));
    // One marker per MultiEdit hunk so each gets its own DiffCard.
    if name == "MultiEdit" {
        let path = input.get("file_path").and_then(|p| p.as_str()).unwrap_or("").to_string();
        let edits = input.get("edits").and_then(|e| e.as_array()).cloned().unwrap_or_default();
        let vals = edits
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
            .collect();
        return Some((name, vals));
    }
    let vals = vec![tool_meta_generic(&name, &input)];
    Some((name, vals))
}

/// Kimi tool_call object → (name, marker values). Kimi names tools close to
/// Claude's (Edit/Write/Read/Bash/Grep/Glob…) with args under
/// `function.arguments` (JSON string) or directly as input — both handled.
fn tool_meta_kimi(call: &Value) -> Option<(String, Vec<Value>)> {
    let func = call.get("function").cloned().unwrap_or(call.clone());
    let name = func.get("name").and_then(|n| n.as_str())?.to_string();
    let args = match func.get("arguments") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(json!({})),
        Some(v) => v.clone(),
        None => json!({}),
    };
    let vals = vec![tool_meta_generic(&name, &args)];
    Some((name, vals))
}

/// True for the shell/command tool names used across the harness CLIs.
fn is_shell_name(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "bash" | "shell" | "run_shell" | "run_command"
    )
}

/// Cap captured shell output so a huge dump can't bloat the stored message.
/// Shell output is usually most useful at the tail, so keep the last lines.
fn truncate_output(s: &str) -> String {
    const MAX_LINES: usize = 60;
    const MAX_BYTES: usize = 8_000;
    let lines: Vec<&str> = s.lines().collect();
    let mut out = if lines.len() > MAX_LINES {
        let dropped = lines.len() - MAX_LINES;
        format!(
            "… [{} earlier lines truncated]\n{}",
            dropped,
            lines[lines.len() - MAX_LINES..].join("\n")
        )
    } else {
        s.to_string()
    };
    if out.len() > MAX_BYTES {
        let start = out.len() - MAX_BYTES;
        out = format!("…\n{}", &out[start..]);
    }
    out
}

/// Pull the text out of a tool_result `content` field, which may be a plain
/// string or an array of content blocks (text/image). Only text is useful for
/// the shell preview; other blocks are ignored.
fn extract_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str()).map(String::from)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(v) if !v.is_null() => v.to_string(),
        _ => String::new(),
    }
}

/// Tracks tool calls within a turn so each tool RESULT can be matched back to
/// its call. CLI streams deliver calls and results IN ORDER but interleave
/// non-shell tools with shell tools, so we keep a FIFO of (id, is_shell) per
/// call and pop one slot per result. Only shell calls get a correlation id in
/// their marker (and only shell results produce a result marker) — other tools
/// are tracked solely to keep the order aligned.
struct ToolTracker {
    seq: u64,
    pending: VecDeque<(u64, bool)>,
}
impl ToolTracker {
    fn new() -> Self {
        Self { seq: 0, pending: VecDeque::new() }
    }
    /// Wrap one tool call's marker Value(s) as `<tool>…</tool>`, injecting an
    /// `id` when the call is a shell command, and record the call's slot.
    fn tool_use(&mut self, name: &str, values: Vec<Value>) -> String {
        let id = self.seq;
        self.seq += 1;
        let shell = is_shell_name(name);
        let mut out = String::new();
        for mut v in values {
            if shell {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("id".to_string(), json!(id));
                }
            }
            out.push_str(&format!("<tool>{v}</tool>"));
        }
        self.pending.push_back((id, shell));
        out
    }
    /// Consume the next result slot (in call order). Returns a result marker
    /// carrying the output text only when that call was a shell command.
    fn tool_result(&mut self, text: &str, is_error: bool) -> Option<String> {
        let (id, shell) = self.pending.pop_front()?;
        if !shell {
            return None;
        }
        Some(result_marker_text(id, text, is_error))
    }
    /// Self-contained variant for CLIs that report a tool's call AND its
    /// completed output in one event (opencode). Assigns an id, emits the
    /// command marker, and — for shell tools whose output/error is present —
    /// appends a matching result marker. No pending slot (nothing to match
    /// later), so it can't desync a queue.
    fn tool_use_with_output(
        &mut self,
        name: &str,
        value: Value,
        output: Option<&str>,
        error: Option<&str>,
    ) -> String {
        let id = self.seq;
        self.seq += 1;
        let shell = is_shell_name(name);
        let mut out = String::new();
        let mut v = value;
        if shell {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("id".to_string(), json!(id));
            }
            out.push_str(&format!("<tool>{v}</tool>"));
            if let Some(text) = output.or(error) {
                out.push_str(&result_marker_text(id, text, error.is_some()));
            }
        } else {
            out.push_str(&format!("<tool>{v}</tool>"));
        }
        out
    }
}

/// Build a `<tool>{"kind":"result",…}</tool>` marker that the frontend merges
/// onto the shell step with the matching `id`.
fn result_marker_text(id: u64, text: &str, is_error: bool) -> String {
    let body = json!({
        "kind": "result",
        "id": id,
        "result": sanitize(truncate_output(text)),
        "resultError": is_error,
    });
    format!("<tool>{body}</tool>")
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
    watches: &mut Vec<DirWatch>,
    // Unix-second instant the turn started (captured when the reader began),
    // persisted as `started_at` so the UI can show "Worked for Xs".
    started_at: i64,
) {
    // Persist the assistant message FIRST so we can attribute artifacts to it.
    let message_id: Option<i64> = if !full.is_empty() {
        let conn = db.0.lock();
        // Strip the "harness:" prefix from the agent so the rollup
        // groups harness-backed CLI chat under a clean provider label
        // (e.g. "claude_code" instead of "harness:claude_code").
        let agent: Option<String> = conn
            .query_row(
                "SELECT agent FROM chat_sessions WHERE id = ?1",
                rusqlite::params![sid],
                |r| r.get(0),
            )
            .ok();
        let provider = agent
            .as_deref()
            .and_then(|a| a.strip_prefix("harness:"))
            .unwrap_or("unknown");
        crate::db::add_chat_message(&conn, sid, "assistant", full, input, output, cost, None, None, None, Some(provider), None, None, Some(started_at), Some(crate::db::now_ts()))
            .ok()
            .map(|m| m.id)
    } else {
        None
    };
    full.clear();

    // Diff every watch dir (spawn dir + artifacts dir). `emitted` dedups the
    // (rare) case of overlapping dirs reporting the same file twice.
    let mut emitted = std::collections::HashSet::new();
    for w in watches.iter_mut() {
        let after = snapshot_dir(&w.dir);
        let changed = changed_previewable_files(&w.before, &after);
        // Refresh the baseline so the next turn (claude's persistent process
        // runs many turns against one reader) reports only its own files.
        w.before = after;
        for rel in changed {
            let path = w.dir.join(&rel).to_string_lossy().to_string();
            if !emitted.insert(path.clone()) {
                continue;
            }
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
        let payload = crate::types::ChatTokenPayload {
            chat_session_id: sid.to_string(),
            token: token.to_string(),
        };
        if !crate::chat::stream_events::try_send(sid, &payload) {
            let _ = app.emit("chat:token", payload);
        }
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

    /// M13: a registered one-shot child (a cmd-wrapped tree, like automation
    /// spawns) must die with the app, and the kill must be idempotent —
    /// already-exited children are skipped so a recycled pid is never hit.
    #[test]
    #[cfg(windows)]
    fn kill_one_shot_children_kills_registered_trees() {
        // Sleeper tree mirroring the harness spawn shape: cmd.exe → ping.
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/C", "ping 127.0.0.1 -n 60 >nul"]);
        no_console_window(&mut cmd);
        let child = cmd.spawn().unwrap();
        let child = Arc::new(Mutex::new(child));
        let pid = register_one_shot_child(&child).expect("must register");
        std::thread::sleep(Duration::from_millis(300)); // let the tree start

        kill_one_shot_children();

        let status = child.lock().unwrap().try_wait().unwrap();
        assert!(status.is_some(), "registered one-shot child survived the kill");
        assert!(
            ONE_SHOT_CHILDREN.lock().unwrap().get(&pid).is_none(),
            "registry must be drained after the kill"
        );
        // Idempotent re-run: no registered children, no pid-recycle hazard.
        kill_one_shot_children();
    }

    /// OpenCode "text" events carry the full snapshot of a part's text, not a
    /// delta: only the new suffix must reach `full`/the token stream, and a
    /// non-extending snapshot starts a new part (emitted whole).
    #[test]
    fn opencode_text_events_emit_only_new_suffix() {
        let cell = Arc::new(Mutex::new(None));
        let mut full = String::new();
        let mut last = String::new();
        let (mut input, mut output, mut cost) = (None, None, None);
        let mut tools = ToolTracker::new();
        let ev = |t: &str| json!({ "type": "text", "part": { "text": t } });
        let mut feed = |v: &Value, full: &mut String, last: &mut String| {
            handle_opencode_event(None, "s", v, full, &cell, &mut input, &mut output, &mut cost, last, &mut tools);
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

    /// The artifact watch covers BOTH the spawn dir and the configured
    /// artifacts dir: conduit-tools MCP writes into `storage.artifactsDir`
    /// regardless of the CLI's workspace, so a project-selected turn (or a
    /// custom folder) must still surface MCP-generated files.
    #[test]
    fn turn_watch_dirs_includes_configured_artifacts_dir() {
        let proj = tempfile::tempdir().unwrap();
        let arts = tempfile::tempdir().unwrap();
        let conn = crate::db::mem();
        crate::db::set_setting(
            &conn,
            crate::chat::dispatch::ARTIFACTS_DIR_SETTING_KEY,
            arts.path().to_str().unwrap(),
        )
        .unwrap();
        let db = Arc::new(parking_lot::Mutex::new(conn));
        let dirs = turn_watch_dirs(Some(proj.path().to_str().unwrap()), &db);
        let canon = |p: &Path| std::fs::canonicalize(p).unwrap();
        assert_eq!(dirs.len(), 2, "spawn dir + configured artifacts dir: {dirs:?}");
        assert_eq!(canon(&dirs[0]), canon(proj.path()));
        assert_eq!(canon(&dirs[1]), canon(arts.path()));
    }

    /// With no project and no configured dir, the spawn dir and the artifacts
    /// fallback are the same <Documents>/Conduit — the watch must dedup to
    /// one dir, not snapshot the same tree twice.
    #[test]
    fn turn_watch_dirs_dedups_when_dirs_coincide() {
        let conn = crate::db::mem();
        let db = Arc::new(parking_lot::Mutex::new(conn));
        let dirs = turn_watch_dirs(None, &db);
        assert_eq!(dirs.len(), 1, "{dirs:?}");
    }
}
