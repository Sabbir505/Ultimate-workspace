//! User hooks — scripts the USER configures that run around agent tool calls.
//!
//! Two events, fired from the tool-dispatch choke points (built-in chat's
//! `dispatch::run_tool`, the subagent loop's `subagent_run_tool`, and the
//! relay-tools MCP bridge):
//!
//! * `pre_tool_use` — before a tool executes. A hook can DENY the call
//!   (refusal text feeds back to the model), ASK (routes into the same
//!   approval oneshot the permission cards use), or allow — optionally
//!   rewriting the tool arguments (`updatedInput`) or contributing a note
//!   that is appended to the tool result.
//! * `post_tool_use` — after the tool returns. A hook's `additionalContext`
//!   (or a blocking stderr) is appended to the result text; `async: true`
//!   hooks run detached and are purely observational.
//!
//! I/O contract (mirrors Claude Code's hooks for ecosystem familiarity):
//! the hook command receives one JSON object on stdin; exit 0 continues
//! (stdout parsed as JSON when it parses), exit 2 DENIES with stderr as the
//! reason, any other outcome is an error governed by the hook's `onError`
//! (`open` skips, `closed` denies — a broken guard hook must be allowed to
//! fail closed).
//!
//! Trust: a hook command is arbitrary user-authored code, the same execution
//! class as an MCP-gallery custom server, so the FIRST spawn of each distinct
//! (command, args template) goes through the native `exec_gate` dialog and is
//! remembered per hash — outside the webview, fail-closed on dialog failure.
//! Config lives as a JSON array under the `hooks` app_settings key, edited in
//! Settings → Hooks; the models never see the config, but denial text names
//! the hook so the conversation stays recoverable.
//!
//! ORIGIN SCOPING (`HookDef.origins`, Phase 4 of the Subagent feature): every tool
//! call already carries a dispatch `origin` string — the main chat, a builtin
//! `Task` role, a subagent, a CLI harness, or the relay-tools bridge — and it
//! rides on the hook payload. `origins` narrows a hook to some of those
//! strings: a hook is GLOBAL when the list is empty (the default, so every
//! config saved before this field existed keeps today's behavior) and fires
//! only when the dispatched origin is IN the list otherwise. The vocabulary is
//! `"chat"`, `"subagent"`, `"agent:<id>"` (subagents, id not name, so a
//! rename can't silently unscope a rule), `"harness"` and `"relay_tools"`.
//! This is the advisory tier's only guardrail: for a subagent on a CLI
//! harness Relay cannot restrict the CLI's own tools, so a user writes one
//! `before` deny hook per sensitive tool scoped to `agent:<id>`. The value is
//! never validated against a closed list — subagent ids are dynamic, and an
//! unrecognized origin is preserved verbatim (Settings flags it) rather than
//! dropping the user's hook.
//!
//! Lifecycle events (`turn_complete` / `session_start`) are deliberately NOT
//! origin-scoped: they fire from the global `chat:done` / `chat:error`
//! listeners and from the send path, neither of which knows the dispatch
//! origin (see [`lifecycle_detached`]), so there is nothing to match against.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::exec_gate;

pub const SETTINGS_KEY: &str = "hooks";
/// Post-hook payloads carry a truncated result so scripts can inspect it
/// without receiving megabytes of tool output on stdin.
const RESULT_SNIPPET_CHARS: usize = 4_000;

// ---------------------------------------------------------------------------
// Config model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    /// Fires detached when a chat turn finishes (any engine — the built-in
    /// loop, harness headless runs, ACP — via the global `chat:done` /
    /// `chat:error` events). Observe-only: there is no result to annotate.
    TurnComplete,
    /// Fires detached when a session's FIRST message is sent. Observe-only.
    SessionStart,
    /// Session Mesh: fires detached when a mesh mail is DELIVERED into a
    /// session (the envelope turn is about to run). Observe-only.
    /// (Session Mesh P4.)
    MeshMessage,
    /// Session Mesh: fires detached when a WATCHED mesh turn ends — the
    /// target went idle and the answer was captured (or the watch expired).
    /// Observe-only. (Session Mesh P4.)
    MeshTurnComplete,
}

impl HookEvent {
    /// Lifecycle hooks never gate anything: they are detached observers with
    /// no result text to annotate and no tool call to deny.
    pub fn is_lifecycle(self) -> bool {
        matches!(
            self,
            HookEvent::TurnComplete
                | HookEvent::SessionStart
                | HookEvent::MeshMessage
                | HookEvent::MeshTurnComplete
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OnError {
    /// A failed hook is skipped (logged, never blocks the call). Default.
    #[default]
    Open,
    /// A failed hook denies the call — for guardrail hooks that must fail
    /// closed when their own runtime is broken.
    Closed,
}

/// One user hook. Stored in the `hooks` settings array verbatim (camelCase on
/// the wire — the Settings panel owns editing). `id`, `event` and `command`
/// are required; everything else has a safe default.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDef {
    pub id: String,
    pub event: HookEvent,
    #[serde(default)]
    pub name: String,
    /// Tool names to match: `*` or empty = all; otherwise exact names joined
    /// with `|` (e.g. `write_file|edit_file`). Regex is deliberately NOT
    /// supported (see docs/research/HOOKS_SYSTEM_RESEARCH.md §4.2).
    #[serde(default)]
    pub matcher: String,
    pub command: String,
    /// Exec-form arguments — spawned directly, never through a shell, so
    /// `${tool_input.*}` substitution cannot inject shell syntax.
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    #[serde(default)]
    pub on_error: OnError,
    /// Origin scope: EMPTY = global (the hook fires for every dispatch origin,
    /// which is what every config written before this field means). Non-empty
    /// = the hook fires only when the call's origin string is IN the list —
    /// `"chat"`, `"subagent"`, `"agent:<subagent-id>"`, `"harness"`,
    /// `"relay_tools"` (see the module header). Compared verbatim, so an
    /// unrecognized value simply never matches and is reported in Settings
    /// rather than dropped: subagent ids are dynamic, so the list is deliberately
    /// not a closed vocabulary.
    #[serde(default)]
    pub origins: Vec<String>,
    /// Post-hooks only: run detached and ignore the outcome.
    #[serde(default, rename = "async")]
    pub run_async: bool,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_timeout() -> u64 {
    30
}
fn default_enabled() -> bool {
    true
}

impl HookDef {
    /// Stable identity for the exec-gate allow entry: the command plus its
    /// argument TEMPLATE (not the per-call substitution), so one Allow covers
    /// every invocation of the same configured hook.
    pub(crate) fn gate_ident(&self) -> String {
        format!("{}\u{1}{}", self.command, self.args.join("\u{1}"))
    }
}

/// Load the enabled-hook list from settings. A corrupt/missing entry degrades
/// to "no hooks" — config problems must never take chat down (the Settings
/// panel surfaces validation errors instead). Invalid ENTRIES inside an
/// otherwise-valid array are skipped individually (see [`parse_config_entries`]).
///
/// Cached process-wide for 2 seconds ([`CONFIG_CACHE`]): this runs twice per
/// tool call (pre + post pass), and the DB read adds up. Trade-off: a config
/// change takes effect within ~2s, or immediately — every writer
/// ([`save_config`], hence the Claude import too) calls
/// [`invalidate_config_cache`]; the Settings panel's generic set_setting path
/// relies on the TTL.
pub fn load_config<R: tauri::Runtime>(app: &AppHandle<R>) -> Vec<HookDef> {
    if let Ok(guard) = CONFIG_CACHE.read() {
        if let Some((at, defs)) = guard.as_ref() {
            if at.elapsed() < CONFIG_CACHE_TTL {
                return defs.as_ref().clone();
            }
        }
    }
    let defs = std::sync::Arc::new(load_config_from_db(app));
    if let Ok(mut guard) = CONFIG_CACHE.write() {
        *guard = Some((Instant::now(), std::sync::Arc::clone(&defs)));
    }
    defs.as_ref().clone()
}

fn load_config_from_db<R: tauri::Runtime>(app: &AppHandle<R>) -> Vec<HookDef> {
    let db = app.state::<crate::DbState>();
    let raw = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, SETTINGS_KEY).ok().flatten()
    };
    let Some(raw) = raw else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(items)) => parse_config_entries(&items),
        // A non-array/garbage blob disables everything — that is the one case
        // where there is nothing salvageable to run.
        _ => Vec::new(),
    }
}

/// Process-wide hook-config cache: `(loaded_at, defs)` behind a RwLock. The
/// TTL keeps a config edit from needing an IPC round-trip to invalidate.
static CONFIG_CACHE: std::sync::RwLock<Option<(Instant, std::sync::Arc<Vec<HookDef>>)>> =
    std::sync::RwLock::new(None);
const CONFIG_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(2);

/// Drop the cached hook config so the next [`load_config`] re-reads settings.
/// Called by every Rust-side config writer.
pub fn invalidate_config_cache() {
    if let Ok(mut guard) = CONFIG_CACHE.write() {
        *guard = None;
    }
}

/// Per-entry parse of the hooks settings array: one bad entry is skipped (and
/// logged) instead of disabling the whole system — the previous
/// all-or-nothing `from_str::<Vec<HookDef>>` turned a single typo into "no
/// hooks". That includes a malformed `origins` value (e.g. a string where the
/// array belongs): the ONE entry is skipped, the rest of the array survives, and
/// an origin string that is merely unrecognized is kept verbatim (subagent ids are
/// dynamic — a closed vocabulary would drop a user's hook).
/// Pure so it is unit-testable.
fn parse_config_entries(items: &[Value]) -> Vec<HookDef> {
    items
        .iter()
        .filter_map(|item| match serde_json::from_value::<HookDef>(item.clone()) {
            Ok(def) => Some(def),
            Err(e) => {
                eprintln!("[hooks] skipping invalid hook entry: {e}");
                None
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/// Matcher semantics: `*` / empty matches everything; a matcher made only of
/// word characters, spaces, and `|` separators is an exact-name list; anything
/// containing a regex metacharacter (`.`, `^`, `$`, `(`, `[`, …) is treated as
/// an unanchored regex over the tool name (the `regex` crate is linear-time,
/// so user patterns cannot ReDoS). An invalid regex matches nothing — a typo
/// must not silently broaden the match.
pub fn hook_matches(matcher: &str, tool: &str) -> bool {
    let m = matcher.trim();
    if m.is_empty() || m == "*" {
        return true;
    }
    // Bare `*` already returned above; a `*` anywhere else is a regex
    // metachar and forces regex mode (`write*` means "writ" + zero-or-more
    // e's, NOT a glob).
    let is_plain = m.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '|' || c == ' '
    });
    if is_plain {
        m.split('|')
            .map(str::trim)
            .any(|part| !part.is_empty() && part == tool)
    } else if m == tool {
        // Exact equality wins before the regex reading: a dotted name like
        // `fs.read` (or any pattern that doesn't match its own literal text,
        // e.g. `a+b`) must still be exact-matchable as a tool name.
        true
    } else {
        match regex::Regex::new(m) {
            Ok(re) => re.is_match(tool),
            Err(_) => false,
        }
    }
}

/// Origin scope predicate: an empty `origins` list is GLOBAL (every dispatch
/// origin matches — the pre-`origins` behavior, and what the Claude import
/// produces), otherwise the call's `origin` must be listed verbatim. No
/// normalization or validation happens here: the list is user-authored and
/// subagent ids (`agent:<id>`) are dynamic, so an unknown value is inert rather
/// than rejected. Pure so the scoping matrix is unit-testable without a
/// dispatch path.
pub fn origin_matches(def: &HookDef, origin: &str) -> bool {
    def.origins.is_empty() || def.origins.iter().any(|o| o == origin)
}

/// Replace `${tool_input.key}` tokens in one argument template with values
/// from the tool-call args. String values substitute raw; everything else is
/// compact JSON. A missing key substitutes the empty string. Substitution is
/// single-pass and exec-form: substituted VALUES are never re-scanned as
/// templates (a tool input containing `${tool_input.x}` must not compose a
/// second substitution), and no shell ever sees the result.
pub fn substitute_arg(template: &str, tool_input: &Value) -> String {
    const PREFIX: &str = "${tool_input.";
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find(PREFIX) {
        out.push_str(&rest[..start]);
        let after = &rest[start + PREFIX.len()..];
        match after.find('}') {
            Some(end) => {
                let key = &after[..end];
                let replacement = tool_input
                    .get(key)
                    .map(|v| match v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .unwrap_or_default();
                out.push_str(&replacement);
                rest = &after[end + 1..];
            }
            // Unterminated token: keep it literally and stop scanning.
            None => {
                out.push_str(PREFIX);
                rest = after;
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// What a hook's stdout JSON asked for (Claude-Code-style, minus the fields
/// Relay doesn't model).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct HookOutput {
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub additional_context: Option<String>,
    pub updated_input: Option<Value>,
}

/// Parse hook stdout as the JSON contract when it parses; anything else is
/// plain output (observability only).
pub fn parse_hook_output(stdout: &str) -> HookOutput {
    let trimmed = stdout.trim();
    if !(trimmed.starts_with('{') && trimmed.ends_with('}')) {
        return HookOutput::default();
    }
    let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
        return HookOutput::default();
    };
    HookOutput {
        decision: v
            .get("decision")
            .and_then(Value::as_str)
            .map(str::to_string),
        reason: v.get("reason").and_then(Value::as_str).map(str::to_string),
        additional_context: v
            .get("additionalContext")
            .and_then(Value::as_str)
            .map(str::to_string),
        updated_input: v.get("updatedInput").filter(|v| v.is_object()).cloned(),
    }
}

// ---------------------------------------------------------------------------
// Spawn + classify
// ---------------------------------------------------------------------------

pub struct HookOutcome {
    /// `false` when the exec gate (or a spawn failure) meant the hook never
    /// ran — callers treat this as an error outcome under `onError`.
    pub ran: bool,
    /// Distinguishes "the trust dialog was dismissed" from "the command could
    /// not spawn at all" (a typo'd command) — the Test report surfaces the
    /// difference instead of blaming the dialog for both.
    pub gate_denied: bool,
    pub spawn_failed: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub parse: HookOutput,
}

impl HookOutcome {
    fn not_ran() -> Self {
        Self {
            ran: false,
            gate_denied: false,
            spawn_failed: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
            parse: HookOutput::default(),
        }
    }
}

/// How the exec gate treats a not-yet-trusted hook command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateMode {
    /// Raise the native one-time dialog (interactive tool-hook paths).
    Dialog,
    /// Never block on a dialog: a not-yet-trusted command is skipped. Used by
    /// the detached lifecycle observers, which may fire while nobody is
    /// watching (turn completion) — trust is established via the Test button
    /// or any interactive run of the same command.
    PreTrusted,
}

/// Interactive-path spawn: the first run of a distinct command/template
/// raises the native exec-gate dialog (remembered on Allow); a Deny or failed
/// dialog counts as "did not run" and is subject to the hook's onError policy.
async fn run_hook<R: tauri::Runtime>(app: &AppHandle<R>, def: &HookDef, payload: &Value) -> HookOutcome {
    run_hook_gated(app, def, payload, GateMode::Dialog).await
}

/// Run one hook command for one event payload and classify the result.
/// `gate_mode` controls the one-time trust dialog (see [`GateMode`]).
async fn run_hook_gated<R: tauri::Runtime>(
    app: &AppHandle<R>,
    def: &HookDef,
    payload: &Value,
    gate_mode: GateMode,
) -> HookOutcome {
    // Exec-gate trust (native dialog, remembered per hash — outside the
    // webview so a compromised renderer can't answer it).
    let ident = def.gate_ident();
    let allowed = {
        let db = app.state::<crate::DbState>();
        let already = {
            let conn = db.0.lock();
            exec_gate::is_allowed(&conn, "hook", &ident)
        };
        if already {
            true
        } else if gate_mode == GateMode::PreTrusted {
            false
        } else {
            let body = format!(
                "A user hook is about to run for the first time:\n\n{}\n\n{} {}",
                if def.name.is_empty() { "(unnamed hook)" } else { &def.name },
                def.command,
                def.args.join(" ")
            );
            // The native trust dialog is raised through the dialog plugin,
            // which only the real (Wry) app handle can do. A handle on any
            // other runtime — the `MockRuntime` the unit tests build, which
            // has no windows and therefore no dialog — is treated as "not
            // trusted", i.e. the same skip `GateMode::PreTrusted` makes, so a
            // test can never hang on (or accidentally answer) a dialog. In the
            // shipping app R is always Wry, so this branch is a no-op there.
            let owned = app.clone();
            match (&owned as &dyn std::any::Any).downcast_ref::<AppHandle<tauri::Wry>>() {
                None => false,
                Some(wry) => match exec_gate::confirm_remembered(
                    &db.0,
                    wry,
                    "hook",
                    &ident,
                    "Allow user hook?",
                    body,
                )
                .await
                {
                    Ok(true) => true,
                    _ => false,
                },
            }
        }
    };
    if !allowed {
        let mut o = HookOutcome::not_ran();
        o.gate_denied = true;
        return o;
    }

    let argv: Vec<String> = def
        .args
        .iter()
        .map(|a| substitute_arg(a, payload.get("tool_input").unwrap_or(&Value::Null)))
        .collect();

    let mut cmd = tokio::process::Command::new(&def.command);
    cmd.args(&argv)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    cmd.env("RELAY_HOOK_EVENT", event_name(def.event));
    if let Some(tool) = payload.get("tool_name").and_then(Value::as_str) {
        cmd.env("RELAY_TOOL_NAME", tool);
    }
    if let Some(sid) = payload.get("chat_session_id").and_then(Value::as_str) {
        cmd.env("RELAY_SESSION_ID", sid);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            let mut o = HookOutcome::not_ran();
            o.spawn_failed = true;
            return o;
        }
    };
    // The ENTIRE interaction — stdin write included — sits inside the timeout:
    // a hook that never reads stdin would otherwise block write_all on a full
    // pipe forever (large write_file payloads exceed the pipe buffer), hanging
    // the tool call with no kill switch. kill_on_drop reaps the child when the
    // aborted future drops it.
    let stdin = child.stdin.take();
    let payload_bytes = payload.to_string();
    let waited = tokio::time::timeout(
        std::time::Duration::from_secs(def.timeout_secs.max(1)),
        async move {
            if let Some(mut si) = stdin {
                let _ = si.write_all(payload_bytes.as_bytes()).await;
                // Drop closes the pipe so the hook's read() returns.
            }
            child.wait_with_output().await
        },
    )
    .await;
    match waited {
        Ok(Ok(out)) => {
            // Output cap (audit M: hook output unbounded): a post-hook that
            // cats a huge file ballooned memory before the JSON scan ever saw
            // it. The tool-result side truncates at RESULT_SNIPPET_CHARS; the
            // hook's own output now gets the same treatment (keep the head,
            // marker notes the cut).
            let cap = |mut b: Vec<u8>| -> String {
                const MAX_HOOK_OUTPUT: usize = 1024 * 1024;
                let truncated = b.len() > MAX_HOOK_OUTPUT;
                if truncated {
                    b.truncate(MAX_HOOK_OUTPUT);
                    while !b.is_empty() && (b[b.len() - 1] & 0xC0) == 0x80 {
                        b.pop();
                    }
                }
                let mut s = String::from_utf8_lossy(&b).into_owned();
                if truncated {
                    s.push_str("\n… (output truncated at 1 MiB)");
                }
                s
            };
            let stdout = cap(out.stdout);
            let stderr = cap(out.stderr);
            let exit_code = out.status.code();
            let parse = parse_hook_output(&stdout);
            HookOutcome {
                ran: true,
                gate_denied: false,
                spawn_failed: false,
                exit_code,
                stdout,
                stderr,
                timed_out: false,
                parse,
            }
        }
        Ok(Err(_)) => HookOutcome::not_ran(),
        // Timeout: kill_on_drop reaps the child when the output future is
        // dropped, so nothing leaks past the configured budget.
        Err(_) => {
            let mut o = HookOutcome::not_ran();
            o.timed_out = true;
            o
        }
    }
}

/// Tools that never run hooks: `get_capabilities` is infrastructure, not an
/// agent action — harness CLIs call it at every session start through the
/// relay-tools bridge (and models call it to inspect the environment).
/// Hooking it would add a process spawn (and, on first run, the one-time
/// trust dialog) to every session startup for zero protective value: it is a
/// pure, read-only report.
pub fn is_exempt(tool: &str) -> bool {
    tool == crate::chat::tools::GET_CAPABILITIES
}

pub fn event_name(event: HookEvent) -> &'static str {
    match event {
        HookEvent::PreToolUse => "pre_tool_use",
        HookEvent::PostToolUse => "post_tool_use",
        HookEvent::TurnComplete => "turn_complete",
        HookEvent::SessionStart => "session_start",
        HookEvent::MeshMessage => "mesh_message",
        HookEvent::MeshTurnComplete => "mesh_turn_complete",
    }
}

/// Persist the full hook list (the import command writes merged output;
/// the Settings panel uses the generic set_setting IPC). Drops the config
/// cache so the new list is live immediately on this path.
pub fn save_config(app: &AppHandle, defs: &[HookDef]) -> Result<(), String> {
    let json = serde_json::to_string(defs).map_err(|e| e.to_string())?;
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    crate::db::set_setting(&conn, SETTINGS_KEY, &json).map_err(|e| e.to_string())?;
    invalidate_config_cache();
    Ok(())
}

// ---------------------------------------------------------------------------
// Lifecycle events (turn_complete / session_start) — detached observers
// ---------------------------------------------------------------------------

/// Fire the matching lifecycle hooks without awaiting them. Called from the
/// app-setup listeners on `chat:done` / `chat:error` (turn completion, any
/// engine) and from the send path (first message of a session). Fully
/// detached: config is read inside the spawned task, and lifecycle hooks run
/// `PreTrusted` — they never raise the trust dialog mid-flight. There is no
/// result text, so `decision`/`additionalContext` outputs are ignored; these
/// hooks exist for notification/audit fan-out.
///
/// NOT origin-scoped, and deliberately so: this signature has no origin
/// parameter, because both call sites (the two global listeners in `lib.rs`
/// and the send path in `chat/commands/send.rs`) fire for EVERY engine and have
/// no dispatch origin in hand — the events carry a session id and a status, not
/// the origin that produced the turn. Threading one would mean changing those
/// call sites, so lifecycle hooks stay GLOBAL here and `origins` applies only
/// to the two tool events, which do have a real origin at the gate. Settings
/// says the same next to the picker (hidden for these two events) so nobody
/// writes a scope that has no effect.
pub fn lifecycle_detached<R: tauri::Runtime>(
    app: &AppHandle<R>,
    event: HookEvent,
    sid: &str,
    status: &str,
    preview: &str,
) {
    let app = app.clone();
    let sid = sid.to_string();
    let status = status.to_string();
    let preview = crate::util::truncate_chars(preview, RESULT_SNIPPET_CHARS);
    let spawned = tauri::async_runtime::spawn(async move {
        let defs: Vec<HookDef> = load_config(&app)
            .into_iter()
            .filter(|d| d.enabled && d.event == event)
            // Lifecycle events carry no tool name: only catch-all matchers
            // (`*`/empty) and regexes that match the empty string apply.
            .filter(|d| hook_matches(&d.matcher, ""))
            .collect();
        for def in defs {
            let payload = json!({
                "hook_event_name": event_name(event),
                "chat_session_id": sid,
                "status": status,
                "reply_preview": preview,
            });
            let started = Instant::now();
            let outcome = run_hook_gated(&app, &def, &payload, GateMode::PreTrusted).await;
            let verdict = if !outcome.ran {
                if outcome.gate_denied { "untrusted" } else { "error" }
            } else if outcome.exit_code == Some(0) {
                "ok"
            } else {
                "error"
            };
            emit_hook_run(&app, Some(&sid), event, &def, "", verdict, &outcome, started.elapsed().as_millis());
        }
    });
    drop(spawned);
}

/// Fire the Session Mesh lifecycle hooks (`mesh_message` on delivery,
/// `mesh_turn_complete` when a watched turn ends) without awaiting them —
/// the mesh sibling of [`lifecycle_detached`], carrying the mesh fields the
/// turn events lack: `from_session`, `mail_id`, `mode`, and the envelope/
/// answer preview. Same contract: detached, global (never origin-scoped —
/// the mesh has no dispatch origin in hand), `PreTrusted`, outputs ignored.
pub fn mesh_event_detached<R: tauri::Runtime>(
    app: &AppHandle<R>,
    event: HookEvent,
    target_sid: &str,
    from_session: &str,
    mail_id: &str,
    mode: &str,
    status: &str,
    preview: &str,
) {
    debug_assert!(matches!(event, HookEvent::MeshMessage | HookEvent::MeshTurnComplete));
    let app = app.clone();
    let target_sid = target_sid.to_string();
    let from_session = from_session.to_string();
    let mail_id = mail_id.to_string();
    let mode = mode.to_string();
    let status = status.to_string();
    let preview = crate::util::truncate_chars(preview, RESULT_SNIPPET_CHARS);
    let spawned = tauri::async_runtime::spawn(async move {
        let defs: Vec<HookDef> = load_config(&app)
            .into_iter()
            .filter(|d| d.enabled && d.event == event)
            .filter(|d| hook_matches(&d.matcher, ""))
            .collect();
        for def in defs {
            let payload = json!({
                "hook_event_name": event_name(event),
                "chat_session_id": target_sid,
                "from_session": from_session,
                "mail_id": mail_id,
                "mode": mode,
                "status": status,
                "reply_preview": preview,
            });
            let started = Instant::now();
            let outcome = run_hook_gated(&app, &def, &payload, GateMode::PreTrusted).await;
            let verdict = if !outcome.ran {
                if outcome.gate_denied { "untrusted" } else { "error" }
            } else if outcome.exit_code == Some(0) {
                "ok"
            } else {
                "error"
            };
            emit_hook_run(&app, Some(&target_sid), event, &def, "", verdict, &outcome, started.elapsed().as_millis());
        }
    });
    drop(spawned);
}

// ---------------------------------------------------------------------------
// Harness pane observations + pre-gate (Claude can_use_tool)
// ---------------------------------------------------------------------------

/// Post-hook observation for a HARNESS CLI's own tool call (the CLI executes
/// it; Relay only sees the stream event). Fire-and-forget so the reader
/// thread is never delayed; annotations are discarded (there is no Relay-side
/// result to annotate — the CLI owns it).
pub fn harness_observation<R: tauri::Runtime>(
    app: Option<&AppHandle<R>>,
    sid: &str,
    tool: &str,
    tool_input: &Value,
) {
    let Some(app) = app else {
        return;
    };
    // Cheap pre-check on the calling thread: avoids a task spawn per harness
    // tool call when no post hooks are configured. Origin scope included (the
    // calls below are hard-wired to the `harness` origin) so an origins-scoped
    // post hook for another origin doesn't pay for a pointless spawn.
    let any = load_config(app).into_iter().any(|d| {
        d.enabled
            && d.event == HookEvent::PostToolUse
            && hook_matches(&d.matcher, tool)
            && origin_matches(&d, "harness")
    });
    if !any {
        return;
    }
    let app = app.clone();
    let sid = sid.to_string();
    let tool = tool.to_string();
    let tool_input = tool_input.clone();
    let spawned = tauri::async_runtime::spawn(async move {
        let _ = run_post_tool(
            &app,
            Some(&sid),
            &tool,
            &tool_input,
            String::new(),
            "harness",
            "harness",
        )
        .await;
    });
    drop(spawned);
}

/// What the harness pre-gate decided about a CLI tool call (Claude Code's
/// `can_use_tool` control request).
pub enum HarnessGateVerdict {
    /// No hook had an opinion — fall through to the session's own posture.
    Proceed,
    /// A hook denied: answer the CLI's control request with a deny now.
    Deny { reason: String },
    /// A hook asked: in card-capable postures this forces the approval card
    /// (more restrictive, never less); under full_auto the no-cards contract
    /// degrades it to proceed (the CLI is auto-allowed and the dropped ask is
    /// reported via [`emit_ask_dropped`]).
    Ask,
}

/// Report a hook `ask` that full_auto's no-cards contract degraded to a
/// proceed. Purely observational, on the same `chat:hook-run` channel and
/// payload shape as [`emit_hook_run`] — no hook actually ran, so the outcome
/// fields are empty.
pub fn emit_ask_dropped(app: &AppHandle, sid: &str, tool: &str) {
    let _ = app.emit(
        "chat:hook-run",
        json!({
            "chat_session_id": sid,
            "event": "pre_tool_use",
            "hookName": "",
            "tool": tool,
            "verdict": "ask-dropped",
            "exitCode": null,
            "timedOut": false,
            "durationMs": 0,
        }),
    );
}

/// Pre-hook gate for harness tool calls, evaluated from the reader thread via
/// `block_on` (the CLI is blocked waiting on our control response either way,
/// so a bounded hook run adds no deadlock risk). Argument rewrites from
/// `updatedInput` flow into `input` and ride the allow response.
pub async fn run_harness_pre_gate(
    app: &AppHandle,
    sid: &str,
    tool: &str,
    input: &mut Value,
    permission_mode: &str,
) -> HarnessGateVerdict {
    if is_exempt(tool) {
        return HarnessGateVerdict::Proceed;
    }
    match run_pre_tool(app, Some(sid), tool, input, "harness", permission_mode).await {
        PreVerdict::Proceed { .. } => HarnessGateVerdict::Proceed,
        PreVerdict::Deny { reason } => HarnessGateVerdict::Deny { reason },
        PreVerdict::Ask { .. } => HarnessGateVerdict::Ask,
    }
}

// ---------------------------------------------------------------------------
// Claude Code settings import
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeImportReport {
    pub imported: Vec<String>,
    pub skipped_duplicates: usize,
    pub skipped_non_command: usize,
    pub file_found: bool,
}

/// Parse a `~/.claude/settings.json`-shaped hooks object into Relay defs.
/// Pure (no IO) so it is unit-testable: `{"PreToolUse": [{"matcher": "Bash",
/// "hooks": [{"type": "command", "command": "...", "timeout": 600}]}]}`.
/// Only `type: "command"` handlers import — Relay's exec-form spawn cannot
/// faithfully express http/prompt/agent handlers. Because Claude runs command
/// hooks through a shell and Relay never does, the raw command string is
/// wrapped for the platform shell (`cmd /C` on Windows, `sh -c` elsewhere —
/// explicitly shell, explicitly the user's own config: same trust class as
/// the imported file itself). Ids are content-derived
/// (`claude-{event}-{hash}`), so re-imports dedupe idempotently instead of
/// colliding positional ids across events.
pub fn parse_claude_hooks(raw: &str, existing: &[HookDef]) -> (Vec<HookDef>, ClaudeImportReport) {
    let mut report = ClaudeImportReport {
        imported: Vec::new(),
        skipped_duplicates: 0,
        skipped_non_command: 0,
        file_found: true,
    };
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return (Vec::new(), report);
    };
    let Some(map) = v.get("hooks").and_then(Value::as_object) else {
        return (Vec::new(), report);
    };

    let mut out: Vec<HookDef> = Vec::new();
    for (claude_event, groups) in map {
        let event = match claude_event.as_str() {
            "PreToolUse" => HookEvent::PreToolUse,
            "PostToolUse" => HookEvent::PostToolUse,
            _ => continue,
        };
        let Some(groups) = groups.as_array() else { continue };
        for group in groups {
            let matcher = group
                .get("matcher")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let Some(handlers) = group.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for handler in handlers {
                if handler.get("type").and_then(Value::as_str) != Some("command") {
                    report.skipped_non_command += 1;
                    continue;
                }
                let Some(command) = handler.get("command").and_then(Value::as_str) else {
                    continue;
                };
                if command.trim().is_empty() {
                    continue;
                }
                // Claude's timeout field is SECONDS (their default 600).
                let timeout_secs = handler
                    .get("timeout")
                    .and_then(Value::as_u64)
                    .map(|s| s.clamp(1, 600))
                    .unwrap_or_else(default_timeout);
                // Claude command hooks are shell lines; Relay spawns
                // exec-form, so the import wraps the line for the platform
                // shell (cmd on Windows, sh elsewhere).
                let (shell, shell_flag) = if cfg!(windows) {
                    ("cmd", "/C")
                } else {
                    ("sh", "-c")
                };
                // Content-derived id: two parses of the same (event, matcher,
                // command line) produce the SAME id, so re-imports stay
                // idempotent and ids from different events never collide the
                // way the old positional `claude-{event}-{n}` ids did.
                let def = HookDef {
                    id: {
                        let mut hasher = DefaultHasher::new();
                        event_name(event).hash(&mut hasher);
                        matcher.hash(&mut hasher);
                        command.hash(&mut hasher);
                        format!("claude-{}-{:016x}", event_name(event), hasher.finish())
                    },
                    event,
                    name: format!(
                        "claude-import {}",
                        command.split_whitespace().next().unwrap_or("hook")
                    ),
                    matcher: matcher.clone(),
                    command: shell.into(),
                    args: vec![shell_flag.to_string(), command.to_string()],
                    timeout_secs,
                    on_error: OnError::Open,
                    run_async: false,
                    // Claude has no origin concept — imports stay GLOBAL
                    // (empty = every origin). The user narrows a hook in
                    // Settings, where the origin vocabulary is documented.
                    origins: Vec::new(),
                    enabled: true,
                };
                // Dedupe against current config AND earlier imports in this
                // batch (same event + matcher + command line).
                let dup = existing.iter().any(|e| {
                    e.event == def.event
                        && e.matcher == def.matcher
                        && e.args.last().map(String::as_str) == Some(command)
                }) || out.iter().any(|e| {
                    e.event == def.event
                        && e.matcher == def.matcher
                        && e.args.last().map(String::as_str) == Some(command)
                });
                if dup {
                    report.skipped_duplicates += 1;
                    continue;
                }
                report.imported.push(def.name.clone());
                out.push(def);
            }
        }
    }
    (out, report)
}

fn hook_payload(
    event: HookEvent,
    sid: Option<&str>,
    tool: &str,
    tool_input: &Value,
    origin: &str,
    permission_mode: &str,
    tool_result: Option<&str>,
) -> Value {
    let mut payload = json!({
        "hook_event_name": event_name(event),
        "chat_session_id": sid,
        "tool_name": tool,
        "tool_input": tool_input,
        "origin": origin,
        "permission_mode": permission_mode,
    });
    if let Some(result) = tool_result {
        payload["tool_result"] =
            Value::String(crate::util::truncate_chars(result, RESULT_SNIPPET_CHARS));
    }
    payload
}

fn emit_hook_run<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sid: Option<&str>,
    event: HookEvent,
    def: &HookDef,
    tool: &str,
    verdict: &str,
    outcome: &HookOutcome,
    duration_ms: u128,
) {
    let _ = app.emit(
        "chat:hook-run",
        json!({
            "chat_session_id": sid,
            "event": event_name(event),
            "hookName": def.name,
            "tool": tool,
            "verdict": verdict,
            "exitCode": outcome.exit_code,
            "timedOut": outcome.timed_out,
            "durationMs": duration_ms.min(u128::from(u32::MAX)) as u32,
        }),
    );
}

// ---------------------------------------------------------------------------
// pre_tool_use
// ---------------------------------------------------------------------------

/// What the pre-hook pass decided about one tool call.
#[derive(Debug)]
pub enum PreVerdict {
    /// Run the tool; `note` (from a hook's `additionalContext`) is appended
    /// to the eventual tool result. Argument rewrites are applied in place.
    Proceed { note: Option<String> },
    /// Pause on the approval oneshot — the user decides on a real card.
    Ask { reason: String },
    /// Refuse the call; the reason becomes the tool-result text.
    Deny { reason: String },
}

/// Run every enabled `pre_tool_use` hook matching `tool`. Sequential and
/// deterministic: the first Deny short-circuits; Deny beats Ask; argument
/// rewrites cascade into later hooks' payloads. `sid` is `None` on paths with
/// no session identity (the relay-tools MCP bridge).
pub async fn run_pre_tool<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sid: Option<&str>,
    tool: &str,
    args: &mut Value,
    origin: &str,
    permission_mode: &str,
) -> PreVerdict {
    let defs: Vec<HookDef> = load_config(app)
        .into_iter()
        .filter(|d| d.enabled && d.event == HookEvent::PreToolUse && hook_matches(&d.matcher, tool))
        // Origin scope (Phase 4): a global hook (empty `origins`) fires for
        // every dispatch origin; a scoped one only for its listed origins —
        // this is the advisory tier's guardrail for subagents on a CLI
        // harness, where Relay cannot restrict the CLI's own tools.
        .filter(|d| origin_matches(d, origin))
        .collect();
    if defs.is_empty() {
        return PreVerdict::Proceed { note: None };
    }

    let mut ask: Option<String> = None;
    let mut note: Option<String> = None;
    for def in defs {
        let payload = hook_payload(
            HookEvent::PreToolUse,
            sid,
            tool,
            args,
            origin,
            permission_mode,
            None,
        );
        let started = Instant::now();
        let outcome = run_hook(app, &def, &payload).await;

        let deny_reason = if !outcome.ran {
            (def.on_error == OnError::Closed)
                .then(|| format!("hook \"{}\" did not run (denied or failed to spawn)", hook_label(&def)))
        } else if outcome.timed_out {
            (def.on_error == OnError::Closed)
                .then(|| format!("hook \"{}\" timed out", hook_label(&def)))
        } else if outcome.exit_code == Some(2) {
            Some(blocking_reason(&def.name, &outcome.stderr))
        } else if !matches!(outcome.exit_code, Some(0)) {
            (def.on_error == OnError::Closed)
                .then(|| format!("hook \"{}\" failed (exit {:?})", hook_label(&def), outcome.exit_code))
        } else if outcome.parse.decision.as_deref() == Some("deny") {
            Some(blocking_reason(
                &def.name,
                outcome.parse.reason.as_deref().unwrap_or("denied by hook"),
            ))
        } else {
            None
        };
        // The per-hook verdict mirrors the classified outcome (deny wins —
        // the emit happens even on the short-circuit return below).
        let verdict = if deny_reason.is_some() {
            "deny"
        } else if outcome.gate_denied {
            "untrusted"
        } else if outcome.parse.decision.as_deref() == Some("ask") {
            "ask"
        } else if !outcome.ran || outcome.timed_out || outcome.exit_code != Some(0) {
            "error"
        } else {
            "ok"
        };
        emit_hook_run(
            app,
            sid,
            HookEvent::PreToolUse,
            &def,
            tool,
            verdict,
            &outcome,
            started.elapsed().as_millis(),
        );
        if let Some(reason) = deny_reason {
            return PreVerdict::Deny { reason };
        }
        if outcome.parse.decision.as_deref() == Some("ask") && ask.is_none() {
            ask = Some(
                outcome
                    .parse
                    .reason
                    .clone()
                    .unwrap_or_else(|| format!("hook \"{}\" asked for approval", hook_label(&def))),
            );
        }
        if let Some(updated) = outcome.parse.updated_input {
            *args = updated;
        }
        if note.is_none() {
            note = outcome.parse.additional_context;
        }
    }

    match ask {
        Some(reason) => PreVerdict::Ask { reason },
        None => PreVerdict::Proceed { note },
    }
}

fn hook_label(def: &HookDef) -> &str {
    if def.name.is_empty() {
        def.command.as_str()
    } else {
        &def.name
    }
}

fn blocking_reason(name: &str, stderr_reason: &str) -> String {
    let reason = crate::util::truncate_chars(stderr_reason.trim(), 400);
    if reason.is_empty() {
        format!("blocked by user hook \"{name}\"")
    } else {
        format!("blocked by user hook \"{name}\": {reason}")
    }
}

/// The standard refusal when a hook's `ask` lands on a path that cannot show
/// an approval card (subagents, unattended harness bridges) — one wording for
/// every caller so the model sees a uniform instruction.
pub fn refuse_ask(name: &str) -> String {
    format!(
        "Error: `{name}` needs manual approval per a user hook, and this path cannot ask. \
         Run it from the main chat instead."
    )
}

// ---------------------------------------------------------------------------
// post_tool_use
// ---------------------------------------------------------------------------

/// Whether a post-hook outcome flags the result (annotated as such in the
/// tool text): Claude Code's PostToolUse contract blocks via exit 2 OR a JSON
/// `decision` of `deny`/`block`. Pure so the contract is unit-testable.
fn post_flagged(ran: bool, exit_code: Option<i32>, decision: Option<&str>) -> bool {
    ran && (exit_code == Some(2) || matches!(decision, Some("deny") | Some("block")))
}

/// Run the matching `post_tool_use` hooks against a completed tool result and
/// return the (possibly annotated) result text. Sync hooks contribute context;
/// async hooks run detached as pure observers. Post hooks can never fail the
/// tool — worst case the annotation is skipped.
pub async fn run_post_tool<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sid: Option<&str>,
    tool: &str,
    tool_input: &Value,
    result: String,
    origin: &str,
    permission_mode: &str,
) -> String {
    let defs: Vec<HookDef> = load_config(app)
        .into_iter()
        .filter(|d| d.enabled && d.event == HookEvent::PostToolUse && hook_matches(&d.matcher, tool))
        // Origin scope, same predicate as the pre pass (module header).
        .filter(|d| origin_matches(d, origin))
        .collect();
    if defs.is_empty() {
        return result;
    }

    let mut annotations: Vec<String> = Vec::new();
    for def in defs {
        // The REAL tool input rides on post payloads too — a format-after-edit
        // hook substitutes ${tool_input.path} to know which file to format.
        let payload = hook_payload(
            HookEvent::PostToolUse,
            sid,
            tool,
            tool_input,
            origin,
            permission_mode,
            Some(&result),
        );
        if def.run_async {
            // Detached observer: the moved app handle keeps the emitter alive;
            // nothing about the turn waits on this.
            let app = app.clone();
            let sid = sid.map(str::to_string);
            let tool = tool.to_string();
            let def = def.clone();
            tokio::spawn(async move {
                let started = Instant::now();
                let outcome = run_hook(&app, &def, &payload).await;
                let verdict = if outcome.ran && outcome.exit_code == Some(0) {
                    "ok"
                } else {
                    "error"
                };
                emit_hook_run(
                    &app,
                    sid.as_deref(),
                    HookEvent::PostToolUse,
                    &def,
                    &tool,
                    verdict,
                    &outcome,
                    started.elapsed().as_millis(),
                );
            });
            continue;
        }

        let started = Instant::now();
        let outcome = run_hook(app, &def, &payload).await;
        let flagged = post_flagged(outcome.ran, outcome.exit_code, outcome.parse.decision.as_deref());
        emit_hook_run(
            app,
            sid,
            HookEvent::PostToolUse,
            &def,
            tool,
            if flagged { "flagged" } else { "ok" },
            &outcome,
            started.elapsed().as_millis(),
        );

        if flagged {
            let text = outcome
                .parse
                .reason
                .clone()
                .unwrap_or_else(|| outcome.stderr.clone());
            let text = crate::util::truncate_chars(text.trim(), 400);
            if !text.is_empty() {
                annotations.push(format!("[user hook \"{}\" flagged this result: {text}]", hook_label(&def)));
            }
        } else if let Some(ctx) = outcome.parse.additional_context {
            let ctx = crate::util::truncate_chars(ctx.trim(), 2_000);
            if !ctx.is_empty() {
                annotations.push(format!("[user hook \"{}\"] {ctx}", hook_label(&def)));
            }
        }
    }

    if annotations.is_empty() {
        result
    } else {
        format!("{result}\n\n{}", annotations.join("\n"))
    }
}

// ---------------------------------------------------------------------------
// Test invocation (Settings → Hooks → Test)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookTestReport {
    pub ran: bool,
    pub gate_denied: bool,
    pub spawn_failed: bool,
    pub timed_out: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub duration_ms: u32,
}

/// Run one hook against a synthetic payload shaped for ITS event (lifecycle
/// hooks get a turn_complete/session_start payload; tool hooks get the
/// write_file one) — the Settings panel's Test button. Goes through the same
/// exec gate, so confirming the dialog here also trusts the hook for live
/// turns.
pub async fn test_hook<R: tauri::Runtime>(app: &AppHandle<R>, def: &HookDef) -> HookTestReport {
    let payload = match def.event {
        HookEvent::TurnComplete => json!({
            "hook_event_name": "turn_complete",
            "chat_session_id": null,
            "status": "done",
            "reply_preview": "Relay hook test",
        }),
        HookEvent::SessionStart => json!({
            "hook_event_name": "session_start",
            "chat_session_id": null,
            "status": "start",
            "reply_preview": "Relay hook test",
        }),
        HookEvent::MeshMessage => json!({
            "hook_event_name": "mesh_message",
            "chat_session_id": null,
            "from_session": null,
            "mail_id": "test",
            "mode": "question",
            "status": "delivered",
            "reply_preview": "Relay hook test",
        }),
        HookEvent::MeshTurnComplete => json!({
            "hook_event_name": "mesh_turn_complete",
            "chat_session_id": null,
            "from_session": null,
            "mail_id": "test",
            "mode": "question",
            "status": "answered",
            "reply_preview": "Relay hook test",
        }),
        HookEvent::PreToolUse => hook_payload(
            HookEvent::PreToolUse,
            None,
            "write_file",
            &json!({ "path": "hooks-test.txt", "content": "Relay hook test" }),
            "test",
            "test",
            None,
        ),
        HookEvent::PostToolUse => hook_payload(
            HookEvent::PostToolUse,
            None,
            "write_file",
            &json!({ "path": "hooks-test.txt", "content": "Relay hook test" }),
            "test",
            "test",
            Some("Relay hook test"),
        ),
    };
    let started = Instant::now();
    let outcome = run_hook(app, def, &payload).await;
    HookTestReport {
        ran: outcome.ran,
        gate_denied: outcome.gate_denied,
        spawn_failed: outcome.spawn_failed,
        timed_out: outcome.timed_out,
        exit_code: outcome.exit_code,
        stdout: crate::util::truncate_chars(&outcome.stdout, 2_000),
        stderr: crate::util::truncate_chars(&outcome.stderr, 2_000),
        decision: outcome.parse.decision,
        reason: outcome.parse.reason,
        duration_ms: started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32,
    }
}

// ---------------------------------------------------------------------------
// Tests (pure helpers — process spawning is exercised via the Test button)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matcher_semantics() {
        assert!(hook_matches("*", "write_file"));
        assert!(hook_matches("", "write_file"));
        assert!(hook_matches("  ", "read_file"));
        assert!(hook_matches("write_file|edit_file", "edit_file"));
        assert!(!hook_matches("write_file|edit_file", "read_file"));
        // Exact-name discipline: plain names never prefix-match.
        assert!(!hook_matches("write", "write_file"));
        // Empty alternatives are ignored, not wildcard.
        assert!(!hook_matches("|", "write_file"));
    }

    #[test]
    fn substitution_strings_objects_and_missing_keys() {
        let input = json!({ "path": "src/a b.txt", "n": 3, "flag": true });
        assert_eq!(
            substitute_arg("${tool_input.path}", &input),
            "src/a b.txt"
        );
        assert_eq!(substitute_arg("--count=${tool_input.n}", &input), "--count=3");
        assert_eq!(substitute_arg("${tool_input.flag}", &input), "true");
        assert_eq!(substitute_arg("${tool_input.missing}", &input), "");
        // Objects substitute as compact JSON, and a non-object input is null.
        let obj = json!({ "opts": { "a": 1 } });
        assert_eq!(
            substitute_arg("${tool_input.opts}", &obj),
            "{\"a\":1}"
        );
        assert_eq!(substitute_arg("${tool_input.x}", &Value::Null), "");
        // Unterminated token is left alone rather than looping forever.
        assert_eq!(substitute_arg("${tool_input.path", &input), "${tool_input.path");
    }

    #[test]
    fn regex_matcher_semantics() {
        // A metacharacter flips the matcher into regex mode (unanchored).
        assert!(hook_matches("write_.*", "write_file"));
        assert!(hook_matches("^run_", "run_shell"));
        assert!(!hook_matches("^run_", "write_file"));
        // Invalid regex matches nothing — a typo must not broaden the match.
        assert!(!hook_matches("([unclosed", "write_file"));
        // Plain names stay EXACT even when they prefix a real tool name.
        assert!(!hook_matches("write", "write_file"));
        // Regexes that match the empty string (lifecycle match target).
        assert!(hook_matches(".*", ""));
        assert!(hook_matches("^$", ""));
        // `a|` is plain word chars + pipe -> EXACT-list mode, not regex.
        assert!(!hook_matches("a|", ""));
        assert!(!hook_matches("x", ""));
    }

    #[test]
    fn lifecycle_detached_payload_semantics() {
        // Session-start hooks only catch catch-all matchers: the match target
        // is the empty tool name.
        assert!(hook_matches("*", ""));
        assert!(hook_matches("", ""));
        assert!(!hook_matches("write_file", ""));
    }

    #[test]
    fn substitution_is_single_pass() {
        // A substituted VALUE that itself looks like a token must never be
        // re-substituted (values are data, not templates).
        let input = json!({ "path": "${tool_input.content}", "content": "secret" });
        assert_eq!(
            substitute_arg("${tool_input.path}", &input),
            "${tool_input.content}"
        );
        // Multiple tokens in one template all substitute.
        assert_eq!(
            substitute_arg("${tool_input.a}|${tool_input.b}", &json!({ "a": "x", "b": "y" })),
            "x|y"
        );
    }

    #[test]
    fn output_parsing_contract() {
        // Non-JSON stdout is plain output, not a decision.
        assert_eq!(parse_hook_output("hello\n"), HookOutput::default());
        // Garbage that looks braces-ish still parses to defaults.
        assert_eq!(parse_hook_output("{not json}"), HookOutput::default());
        let parsed = parse_hook_output(
            r#"{"decision":"deny","reason":"no writes to secrets","additionalContext":"note"}"#,
        );
        assert_eq!(parsed.decision.as_deref(), Some("deny"));
        assert_eq!(parsed.reason.as_deref(), Some("no writes to secrets"));
        assert_eq!(parsed.additional_context.as_deref(), Some("note"));
        assert!(parsed.updated_input.is_none());
        let parsed = parse_hook_output(
            r#"{"decision":"allow","updatedInput":{"path":"rewritten.txt"}}"#,
        );
        assert_eq!(parsed.decision.as_deref(), Some("allow"));
        assert_eq!(
            parsed.updated_input.as_ref().unwrap()["path"],
            "rewritten.txt"
        );
        // Non-object updatedInput is rejected (never used as args).
        assert!(parse_hook_output(r#"{"updatedInput":[1]}"#)
            .updated_input
            .is_none());
    }

    #[test]
    fn claude_import_maps_command_hooks_and_dedupes() {
        let raw = r#"{"hooks":{
            "PreToolUse":[{"matcher":"Bash","hooks":[
                {"type":"command","command":"my-guard.js","timeout":900},
                {"type":"prompt","command":"judge it"}]},
            {"matcher":"Write|Edit","hooks":[{"type":"command","command":"other.js"}]}],
            "PostToolUse":[{"matcher":"","hooks":[{"type":"command","command":"audit.js"}]}],
            "SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"ignored.js"}]}]
        }}"#;
        let (defs, report) = parse_claude_hooks(raw, &[]);
        assert_eq!(defs.len(), 3, "prompt + non-mapped events skipped");
        assert_eq!(report.skipped_non_command, 1);
        // Map iteration order is alphabetical (BTreeMap) — find by matcher,
        // never by position.
        let guard = defs.iter().find(|d| d.matcher == "Bash").unwrap();
        assert_eq!(guard.event, HookEvent::PreToolUse);
        // The import wraps shell lines for the PLATFORM shell.
        let (shell, flag) = if cfg!(windows) { ("cmd", "/C") } else { ("sh", "-c") };
        assert_eq!(guard.command, shell);
        assert_eq!(guard.args, vec![flag.to_string(), "my-guard.js".to_string()]);
        assert_eq!(guard.timeout_secs, 600, "seconds, clamped to 600");
        assert!(defs.iter().any(|d| d.event == HookEvent::PostToolUse && d.matcher.is_empty()));
        assert!(defs.iter().any(|d| d.matcher == "Write|Edit"));

        // Re-import against the already-imported config: all duplicates.
        let (defs2, report2) = parse_claude_hooks(raw, &defs);
        assert!(defs2.is_empty());
        assert_eq!(report2.skipped_duplicates, 3);
        assert!(report2.file_found);
    }

    #[test]
    fn claude_import_rejects_garbage() {
        let (defs, report) = parse_claude_hooks("{not json", &[]);
        assert!(defs.is_empty());
        let (defs, _) = parse_claude_hooks(r#"{"no_hooks_key":1}"#, &[]);
        assert!(defs.is_empty());
    }

    #[test]
    fn payload_carries_truncated_result_and_fields() {
        let payload = hook_payload(
            HookEvent::PostToolUse,
            Some("sess"),
            "run_shell",
            &json!({}),
            "chat",
            "full_access",
            Some(&"x".repeat(9_000)),
        );
        assert_eq!(payload["hook_event_name"], "post_tool_use");
        assert_eq!(payload["chat_session_id"], "sess");
        assert_eq!(payload["origin"], "chat");
        let result = payload["tool_result"].as_str().unwrap();
        assert_eq!(result.chars().count(), RESULT_SNIPPET_CHARS);
    }

    #[test]
    fn claude_import_ids_are_deterministic() {
        let raw = r#"{"hooks":{
            "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"my-guard.js"}]}],
            "PostToolUse":[{"matcher":"","hooks":[{"type":"command","command":"audit.js"}]}]
        }}"#;
        // Two parses of the same config produce the SAME content-derived ids
        // (the old positional ids collided across events/import batches).
        let (defs, _) = parse_claude_hooks(raw, &[]);
        let (defs2, _) = parse_claude_hooks(raw, &[]);
        assert_eq!(defs.len(), 2);
        for (a, b) in defs.iter().zip(defs2.iter()) {
            assert_eq!(a.id, b.id, "ids must be deterministic across parses");
            assert!(a.id.starts_with(&format!("claude-{}-", event_name(a.event))));
        }
        assert_ne!(defs[0].id, defs[1].id);
    }

    #[test]
    fn post_flagged_contract() {
        // Claude Code's PostToolUse contract: exit 2 OR decision deny/block.
        assert!(post_flagged(true, Some(2), None));
        assert!(post_flagged(true, Some(0), Some("deny")));
        assert!(post_flagged(true, Some(0), Some("block")));
        // Other outcomes are not flags.
        assert!(!post_flagged(true, Some(0), None));
        assert!(!post_flagged(true, Some(0), Some("ask")));
        assert!(!post_flagged(true, Some(1), None), "non-2 exit is an error, not a flag");
        // A hook that never ran cannot flag anything.
        assert!(!post_flagged(false, Some(2), Some("deny")));
    }

    #[test]
    fn matcher_exact_equality_beats_regex_mode() {
        // A metachar-containing matcher still exact-matches ITSELF: dotted
        // tool names (`fs.read`) and patterns that don't match their own
        // literal text (`a+b`) must be expressible.
        assert!(hook_matches("fs.read", "fs.read"));
        assert!(hook_matches("a+b", "a+b"));
        // The regex reading is unchanged for non-equal names.
        assert!(hook_matches("fs.read", "fsXread"));
    }

    #[test]
    fn config_entries_skip_invalid_items() {
        let good = json!({
            "id": "h1",
            "event": "pre_tool_use",
            "command": "node",
            "args": ["-e", "1"]
        });
        let entries = vec![
            good,
            // Bad enum value + a non-object entry: skipped, not fatal.
            json!({ "id": "bad", "event": "no_such_event", "command": "x" }),
            json!("garbage"),
        ];
        let defs = parse_config_entries(&entries);
        assert_eq!(defs.len(), 1, "invalid entries are skipped individually");
        assert_eq!(defs[0].id, "h1");
        assert_eq!(defs[0].command, "node");
    }

    // -----------------------------------------------------------------------
    // Origin scoping (Phase 4 — advisory tier for subagents)
    // -----------------------------------------------------------------------

    /// A `pre_tool_use` hook that denies with the JSON `decision: "deny"`
    /// contract, scoped to `origins`. The script lives in a temp FILE rather
    /// than in the argv: a spawn re-escapes `"` as `\"` and `cmd`/`sh` never
    /// unescape it, so JSON on a command line would arrive mangled. A file is
    /// what a real user hook is anyway.
    fn deny_def(dir: &tempfile::TempDir, id: &str, reason: &str, origins: Vec<String>) -> HookDef {
        let (command, args) = if cfg!(windows) {
            let path = dir.path().join(id).with_extension("cmd");
            std::fs::write(
                &path,
                format!(
                    "@echo off\r\n@echo {{\"decision\":\"deny\",\"reason\":\"{reason}\"}}\r\n@exit /b 0\r\n"
                ),
            )
            .unwrap();
            ("cmd".to_string(), vec!["/C".to_string(), path.display().to_string()])
        } else {
            let path = dir.path().join(format!("{id}.sh"));
            std::fs::write(
                &path,
                format!("printf '%s\\n' '{{\"decision\":\"deny\",\"reason\":\"{reason}\"}}'\nexit 0\n"),
            )
            .unwrap();
            ("sh".to_string(), vec![path.display().to_string()])
        };
        HookDef {
            id: id.to_string(),
            event: HookEvent::PreToolUse,
            name: id.to_string(),
            matcher: "*".to_string(),
            command,
            args,
            timeout_secs: 5,
            on_error: OnError::Open,
            run_async: false,
            origins,
            enabled: true,
        }
    }

    /// A mock app whose in-memory settings DB holds `defs` as the hook config,
    /// with every hook's exec-gate entry pre-remembered so the tests exercise
    /// the FILTER, not the native trust dialog. The config cache is dropped
    /// too, so the write is what the next `load_config` sees.
    fn mock_app_with_hooks(defs: Vec<HookDef>) -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        for d in &defs {
            exec_gate::remember(&conn, "hook", &d.gate_ident());
        }
        crate::db::set_setting(&conn, SETTINGS_KEY, &serde_json::to_string(&defs).unwrap()).unwrap();
        app.manage(crate::DbState(std::sync::Arc::new(parking_lot::Mutex::new(conn))));
        invalidate_config_cache();
        app.handle().clone()
    }

    /// The deny reason a `run_pre_tool` verdict carries, if it denied.
    async fn deny_reason_for(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
        origin: &str,
    ) -> Option<String> {
        let mut args = json!({ "path": "notes.txt", "content": "x" });
        match run_pre_tool(app, Some("s1"), "write_file", &mut args, origin, "workspace_write").await {
            PreVerdict::Deny { reason } => Some(reason),
            PreVerdict::Proceed { .. } | PreVerdict::Ask { .. } => None,
        }
    }

    #[test]
    fn global_hook_fires_for_every_origin_scoped_hook_only_for_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let global = deny_def(&dir, "g", "global", vec![]);
        let subagent = deny_def(&dir, "c", "subagents", vec!["agent:subagent-1".to_string()]);
        // Empty `origins` is GLOBAL: it must match the main chat, a builtin
        // Task role, a subagent, a harness CLI and the relay bridge.
        for origin in ["chat", "subagent", "agent:subagent-1", "harness", "relay_tools"] {
            assert!(origin_matches(&global, origin), "global hook must fire for {origin}");
        }
        // A scoped hook fires ONLY for its listed origins — including the
        // prefix trap: `agent:subagent-1` is not `agent:subagent-10`.
        assert!(origin_matches(&subagent, "agent:subagent-1"));
        assert!(!origin_matches(&subagent, "agent:subagent-10"));
        assert!(!origin_matches(&subagent, "chat"));
        assert!(!origin_matches(&subagent, "subagent"));
        assert!(!origin_matches(&subagent, "harness"));
        // An origin outside the vocabulary (stale or hand-edited) is inert,
        // never an error: the user's hook is kept, it just doesn't match.
        let odd = deny_def(&dir, "o", "odd", vec!["Agent:Subagent-1".to_string(), "nonsense".to_string()]);
        assert!(!origin_matches(&odd, "agent:subagent-1"), "matching is case-sensitive");
        assert!(!origin_matches(&odd, "chat"));
    }

    #[test]
    fn origins_round_trip_and_default_to_global() {
        let dir = tempfile::tempdir().unwrap();
        let scoped = deny_def(
            &dir,
            "c",
            "c",
            vec!["agent:subagent-1".to_string(), "harness".to_string()],
        );
        let json = serde_json::to_string(&scoped).unwrap();
        assert!(json.contains(r#""origins":["agent:subagent-1","harness"]"#));
        let back: HookDef = serde_json::from_str(&json).unwrap();
        assert_eq!(back.origins, scoped.origins);

        // A config saved before the field existed deserializes to the global
        // default instead of failing — every existing hook keeps today's
        // behavior with no migration.
        let legacy = r#"{"id":"h","event":"pre_tool_use","command":"node"}"#;
        let old: HookDef = serde_json::from_str(legacy).unwrap();
        assert!(old.origins.is_empty());
        assert!(origin_matches(&old, "agent:whatever"));
    }

    #[test]
    fn claude_import_defs_stay_global() {
        let raw = r#"{"hooks":{
            "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"my-guard.js"}]}],
            "PostToolUse":[{"matcher":"","hooks":[{"type":"command","command":"audit.js"}]}]
        }}"#;
        let (defs, _) = parse_claude_hooks(raw, &[]);
        assert_eq!(defs.len(), 2);
        for d in &defs {
            assert!(
                d.origins.is_empty(),
                "Claude has no origin concept — imports must stay global"
            );
        }
    }

    #[test]
    fn a_malformed_origins_value_skips_only_its_own_entry() {
        let entries = vec![
            // No `origins` at all -> global.
            json!({ "id": "h1", "event": "pre_tool_use", "command": "node" }),
            // A string where the array belongs -> THIS entry is skipped, the
            // rest of the array survives (never a silent all-or-nothing drop).
            json!({ "id": "h2", "event": "pre_tool_use", "command": "node", "origins": "chat" }),
            // An UNRECOGNIZED but well-formed origin is preserved verbatim:
            // subagent ids are dynamic, so a closed vocabulary would eat hooks.
            json!({ "id": "h3", "event": "pre_tool_use", "command": "node", "origins": ["agent:subagent-9"] }),
        ];
        let defs = parse_config_entries(&entries);
        assert_eq!(defs.len(), 2, "only the malformed entry is dropped");
        let ids: Vec<&str> = defs.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["h1", "h3"]);
        assert!(defs[0].origins.is_empty());
        assert_eq!(defs[1].origins, vec!["agent:subagent-9".to_string()]);
        // And it round-trips back to the settings blob unchanged.
        let saved = serde_json::to_string(&defs).unwrap();
        assert!(saved.contains(r#""origins":["agent:subagent-9"]"#));
    }

    #[tokio::test]
    async fn origin_scoped_deny_blocks_only_its_own_origin() {
        let dir = tempfile::tempdir().unwrap();

        // Phase 1 — a GLOBAL deny (empty `origins`). It must block every
        // origin, which is what "empty = all" has to mean in practice.
        let app = mock_app_with_hooks(vec![deny_def(&dir, "global-guard", "global-guard", vec![])]);
        for origin in ["chat", "subagent", "agent:subagent-1", "harness", "relay_tools"] {
            let reason = deny_reason_for(&app, origin).await;
            assert!(
                reason.as_deref().is_some_and(|r| r.contains("global-guard")),
                "a global hook must fire for {origin}, got {reason:?}"
            );
        }

        // Phase 2 — the advisory-tier case: the SAME kind of deny hook, scoped
        // to one subagent. This is the guardrail for an agent Relay cannot
        // otherwise restrain (a CLI harness running its own tools), so it has
        // to actually STOP the call there and stay out of everyone else's way.
        let app = mock_app_with_hooks(vec![deny_def(
            &dir,
            "subagent-guard",
            "subagent-guard-fired",
            vec!["agent:subagent-1".to_string()],
        )]);
        let reason = deny_reason_for(&app, "agent:subagent-1").await;
        assert!(
            reason.as_deref().is_some_and(|r| r.contains("subagent-guard-fired")),
            "the origin-scoped deny must block agent:subagent-1, got {reason:?}"
        );
        // …and NOT the main chat, a builtin role, another agent, or the CLI
        // harness surface.
        for other in ["chat", "subagent", "agent:subagent-2", "harness", "relay_tools"] {
            assert_eq!(
                deny_reason_for(&app, other).await,
                None,
                "the agent:subagent-1 deny must not fire for {other}"
            );
        }
    }
}
