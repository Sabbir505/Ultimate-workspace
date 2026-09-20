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
}

impl HookEvent {
    /// Lifecycle hooks never gate anything: they are detached observers with
    /// no result text to annotate and no tool call to deny.
    pub fn is_lifecycle(self) -> bool {
        matches!(self, HookEvent::TurnComplete | HookEvent::SessionStart)
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
    fn gate_ident(&self) -> String {
        format!("{}\u{1}{}", self.command, self.args.join("\u{1}"))
    }
}

/// Load the enabled-hook list from settings. A corrupt/missing entry degrades
/// to "no hooks" — config problems must never take chat down (the Settings
/// panel surfaces validation errors instead).
pub fn load_config(app: &AppHandle) -> Vec<HookDef> {
    let db = app.state::<crate::DbState>();
    let raw = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, SETTINGS_KEY).ok().flatten()
    };
    let Some(raw) = raw else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<HookDef>>(&raw).unwrap_or_default()
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
    } else {
        match regex::Regex::new(m) {
            Ok(re) => re.is_match(tool),
            Err(_) => false,
        }
    }
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
async fn run_hook(app: &AppHandle, def: &HookDef, payload: &Value) -> HookOutcome {
    run_hook_gated(app, def, payload, GateMode::Dialog).await
}

/// Run one hook command for one event payload and classify the result.
/// `gate_mode` controls the one-time trust dialog (see [`GateMode`]).
async fn run_hook_gated(app: &AppHandle, def: &HookDef, payload: &Value, gate_mode: GateMode) -> HookOutcome {
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
            match exec_gate::confirm_remembered(
                &db.0,
                app,
                "hook",
                &ident,
                "Allow user hook?",
                body,
            )
            .await
            {
                Ok(true) => true,
                _ => false,
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
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
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
    }
}

/// Persist the full hook list (the import command writes merged output;
/// the Settings panel uses the generic set_setting IPC).
pub fn save_config(app: &AppHandle, defs: &[HookDef]) -> Result<(), String> {
    let json = serde_json::to_string(defs).map_err(|e| e.to_string())?;
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    crate::db::set_setting(&conn, SETTINGS_KEY, &json).map_err(|e| e.to_string())
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
pub fn lifecycle_detached(
    app: &AppHandle,
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

// ---------------------------------------------------------------------------
// Harness pane observations + pre-gate (Claude can_use_tool)
// ---------------------------------------------------------------------------

/// Post-hook observation for a HARNESS CLI's own tool call (the CLI executes
/// it; Relay only sees the stream event). Fire-and-forget so the reader
/// thread is never delayed; annotations are discarded (there is no Relay-side
/// result to annotate — the CLI owns it).
pub fn harness_observation(app: Option<&AppHandle>, sid: &str, tool: &str, tool_input: &Value) {
    let Some(app) = app else {
        return;
    };
    // Cheap pre-check on the calling thread: avoids a task spawn per harness
    // tool call when no post hooks are configured.
    let any = load_config(app).into_iter().any(|d| {
        d.enabled && d.event == HookEvent::PostToolUse && hook_matches(&d.matcher, tool)
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
    /// A hook asked: force the approval card even in full_auto (more
    /// restrictive, never less).
    Ask,
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
/// wrapped as `cmd /C <string>` (explicitly shell, explicitly the user's own
/// config — same trust class as the imported file itself).
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
                let def = HookDef {
                    id: format!(
                        "claude-{}-{}",
                        event_name(event),
                        out.len() + report.skipped_duplicates
                    ),
                    event,
                    name: format!(
                        "claude-import {}",
                        command.split_whitespace().next().unwrap_or("hook")
                    ),
                    matcher: matcher.clone(),
                    // Claude command hooks are shell lines; Relay spawns
                    // exec-form, so the import wraps the line for cmd.exe.
                    command: "cmd".into(),
                    args: vec!["/C".to_string(), command.to_string()],
                    timeout_secs,
                    on_error: OnError::Open,
                    run_async: false,
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

fn emit_hook_run(
    app: &AppHandle,
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
pub async fn run_pre_tool(
    app: &AppHandle,
    sid: Option<&str>,
    tool: &str,
    args: &mut Value,
    origin: &str,
    permission_mode: &str,
) -> PreVerdict {
    let defs: Vec<HookDef> = load_config(app)
        .into_iter()
        .filter(|d| d.enabled && d.event == HookEvent::PreToolUse && hook_matches(&d.matcher, tool))
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
        emit_hook_run(
            app,
            sid,
            HookEvent::PreToolUse,
            &def,
            tool,
            "checked",
            &outcome,
            started.elapsed().as_millis(),
        );

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

// ---------------------------------------------------------------------------
// post_tool_use
// ---------------------------------------------------------------------------

/// Run the matching `post_tool_use` hooks against a completed tool result and
/// return the (possibly annotated) result text. Sync hooks contribute context;
/// async hooks run detached as pure observers. Post hooks can never fail the
/// tool — worst case the annotation is skipped.
pub async fn run_post_tool(
    app: &AppHandle,
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
        let flagged =
            outcome.ran && (outcome.exit_code == Some(2) || outcome.parse.decision.as_deref() == Some("deny"));
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

/// Run one hook against a synthetic `pre_tool_use` payload — the Settings
/// panel's Test button. Goes through the same exec gate, so confirming the
/// dialog here also trusts the hook for live turns.
pub async fn test_hook(app: &AppHandle, def: &HookDef) -> HookTestReport {
    let payload = hook_payload(
        HookEvent::PreToolUse,
        None,
        "write_file",
        &json!({ "path": "hooks-test.txt", "content": "Relay hook test" }),
        "test",
        "test",
        None,
    );
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
        assert_eq!(guard.command, "cmd");
        assert_eq!(guard.args, vec!["/C".to_string(), "my-guard.js".to_string()]);
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
}
