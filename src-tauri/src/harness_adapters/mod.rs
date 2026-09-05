//! Pluggable adapter interface for AI coding agent CLIs (PRD §6.4).
//!
//! Relay never talks to an agent's protocol directly — it spawns the harness
//! binary in a pty and scrapes *hints* (session ids, usage/cost lines,
//! diff-approval prompts) out of the stripped terminal output. All scraping
//! is deliberately conservative and best-effort: a missed parse degrades a
//! feature (resume button, cost dashboard) but must never break the pane.

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
use std::sync::Arc;

pub mod claude_code;
pub mod commandcode;
pub mod kimi_code;
pub mod omp;
pub mod opencode;
pub mod pi;
pub mod pricing;

/// A command ready to be turned into a `portable_pty::CommandBuilder`.
///
/// The PRD trait returns `std::process::Command`, but portable-pty needs its
/// own `CommandBuilder`, so adapters return this neutral spec instead and the
/// pty layer converts it. (Deviation from PRD §6.4 signature — noted in
/// BUILD_LOG.md.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl CommandSpec {
    pub fn new(program: &str, args: &[&str]) -> Self {
        Self {
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// Best-effort token/cost usage scraped from harness output.
/// Cost is only ever what the harness itself printed — we never invent a
/// pricing table (CONTRACT/PRD §7.12).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct UsageInfo {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    /// Charged at full input rate (Anthropic's policy).
    pub cache_creation_input_tokens: Option<i64>,
    /// Charged at `cache_read_per_mtok` (Anthropic 0.1× input, OpenAI 0.5×).
    pub cache_read_input_tokens: Option<i64>,
    /// Counted in output cost (Anthropic surfaces this on thinking models).
    pub reasoning_output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
}

pub trait HarnessAdapter: Send + Sync {
    /// Stable id used in the DB and over IPC: "claude_code" | "kimi_code".
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    /// Binary name looked up on PATH.
    fn binary(&self) -> &'static str;
    /// Interactive new-session command, e.g. `claude` / `kimi`.
    fn spawn_new_command(&self) -> CommandSpec;
    /// Resume-by-id command — the core of Relay's pane lifecycle: panes are
    /// killed on close/quit and sessions are resurrected by id later.
    fn spawn_resume_command(&self, session_id: &str) -> CommandSpec;
    /// Interactive login flow command (spawned in a temporary pane, PRD §9).
    fn login_command(&self) -> CommandSpec;
    /// Scrape the harness's own session id from stripped pty output.
    fn parse_session_id(&self, output: &str) -> Option<String>;
    /// On-disk usage/cost totals for a session (PRD §7.12 prefers harness
    /// session logs over pty scraping). Returns cumulative totals plus the
    /// model id when the log records it, so callers can price per-model;
    /// None when nothing is available yet.
    fn usage_from_disk(&self, _cwd: &std::path::Path, _harness_session_id: &str) -> Option<SessionUsage> {
        None
    }
    /// Filesystem fallback for session-id capture: inspect the harness's
    /// on-disk session store for a session created in `cwd` at/after `since`
    /// (pane spawn time). Needed because neither harness reliably prints its
    /// session id in the TUI — Claude writes `~/.claude/projects/<slug>/*.jsonl`,
    /// Kimi appends to `~/.kimi-code/session_index.jsonl`. Default: no probe.
    fn find_session_id_on_disk(&self, _cwd: &std::path::Path, _since: std::time::SystemTime) -> Option<String> {
        None
    }
    /// Scrape usage/cost info from stripped pty output. Conservative.
    fn parse_usage(&self, output: &str) -> Option<UsageInfo>;
    /// Regexes matching the harness's diff-approval prompt. Matched against
    /// the recent output tail when the pane goes quiet; a hit promotes the
    /// pane state from "waiting" to "diff_ready" (PRD §7.3, best-effort).
    fn diff_prompt_patterns(&self) -> &'static [Regex];
    /// True when the binary is runnable on PATH (checked via `--version`).
    fn is_installed(&self) -> bool {
        binary_on_path(self.binary())
    }
}

/// Usage totals plus the model that produced them — the model id (as the
/// harness writes it in its logs) drives per-model pricing (§7.12).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionUsage {
    pub usage: UsageInfo,
    pub model: Option<String>,
}

/// Canonical per-model pricing keys — used both for Settings override keys
/// (`price.<key>.input_per_mtok` / `.output_per_mtok`) and for the default
/// rate table. Model ids from logs are matched loosely (contains) since
/// Claude writes dated ids like "claude-sonnet-4-5-20250929".
pub fn canonical_model_key(model: &str) -> Option<&'static str> {
    let m = model.to_lowercase();
    if m.contains("opus") {
        Some("claude-opus-4-8")
    } else if m.contains("sonnet-5") || m.contains("sonnet_5") {
        Some("claude-sonnet-5")
    } else if m.contains("sonnet") {
        Some("claude-sonnet-4-5")
    } else if m.contains("haiku") {
        Some("claude-haiku-4-5")
    } else if m.contains("kimi-k3") || m.contains("kimi_k3") {
        Some("kimi-k3")
    } else if m.contains("kimi-k2.7") || m.contains("kimi_k2.7") {
        Some("kimi-k2.7-code")
    } else if m.contains("kimi-k2.6") || m.contains("kimi_k2.6") {
        Some("kimi-k2.6")
    } else if m.contains("glm-5.2") || m.contains("glm-5-2") {
        Some("glm-5.2")
    } else if m.contains("glm-5.1") || m.contains("glm-5-1") {
        Some("glm-5.1")
    } else if m.contains("deepseek-v4-pro") || m.contains("deepseek_v4_pro") {
        Some("deepseek-v4-pro")
    } else if m.contains("minimax-m3") || m.contains("minimax_m3") {
        Some("minimax-m3")
    } else if m.contains("qwen3.7-plus") || m.contains("qwen3.7_plus") {
        Some("qwen3.7-plus")
    } else {
        None
    }
}

/// Default rates ($/Mtok input, output) from official pricing pages
/// (anthropic.com, platform.kimi.ai, docs.z.ai, api-docs.deepseek.com,
/// platform.minimax.io, alibabacloud.com — researched 2026-07; claude-sonnet-5
/// is the $2/$10 intro rate valid until 2026-08-31; minimax-m3 uses the
/// "permanent 50% off" effective rate; qwen3.7-plus uses the ≤256K tier).
/// Users override per-model in Settings; everything stays labeled an estimate.
/// NOTE: the user routes both CLIs through a third-party relay whose actual
/// billing may differ from these official list prices.
pub fn default_rates(key: &str) -> Option<(f64, f64)> {
    match key {
        "claude-opus-4-8" => Some((5.0, 25.0)),
        "claude-sonnet-5" => Some((2.0, 10.0)),
        "claude-sonnet-4-5" => Some((3.0, 15.0)),
        "claude-haiku-4-5" => Some((1.0, 5.0)),
        "kimi-k3" => Some((3.0, 15.0)),
        "kimi-k2.7-code" => Some((0.95, 4.0)),
        "kimi-k2.6" => Some((0.95, 4.0)),
        "glm-5.2" => Some((1.4, 4.4)),
        "glm-5.1" => Some((1.4, 4.4)),
        "deepseek-v4-pro" => Some((0.435, 0.87)),
        "minimax-m3" => Some((0.3, 1.2)),
        "qwen3.7-plus" => Some((0.4, 1.6)),
        _ => None,
    }
}

/// Fallback pricing key when the session log names no model.
pub fn harness_default_model_key(harness_id: &str) -> &'static str {
    match harness_id {
        "kimi_code" => "kimi-k3",
        // OpenCode is provider-agnostic — it routes to whatever the user
        // configured — but its out-of-box default is Anthropic Claude, so a
        // Claude Sonnet rate is the least-wrong estimate when the session log
        // names no model. Users override per-model in Settings.
        "opencode" => "claude-sonnet-4-5",
        _ => "claude-sonnet-4-5",
    }
}

/// Registry of all v1 adapters, keyed by adapter id.
pub fn adapters() -> &'static HashMap<&'static str, Arc<dyn HarnessAdapter>> {
    static ADAPTERS: Lazy<HashMap<&'static str, Arc<dyn HarnessAdapter>>> = Lazy::new(|| {
        let mut m: HashMap<&'static str, Arc<dyn HarnessAdapter>> = HashMap::new();
        m.insert("claude_code", Arc::new(claude_code::ClaudeCodeAdapter));
        m.insert("kimi_code", Arc::new(kimi_code::KimiCodeAdapter));
        m.insert("opencode", Arc::new(opencode::OpenCodeAdapter));
        m.insert("pi", Arc::new(pi::PiAdapter));
        m.insert("omp", Arc::new(omp::OmpAdapter));
        m.insert("commandcode", Arc::new(commandcode::CommandCodeAdapter));
        m
    });
    &ADAPTERS
}

/// Stable presentation order for the harness list (Settings table, agent
/// picker, sidebar select). A HashMap iterates in random order, and with six
/// adapters the rows would reshuffle on every cache expiry — so everything
/// that enumerates goes through this order.
const ADAPTER_ORDER: [&str; 6] = ["claude_code", "kimi_code", "opencode", "pi", "omp", "commandcode"];

pub fn get_adapter(id: &str) -> Option<Arc<dyn HarnessAdapter>> {
    adapters().get(id).cloned()
}

pub fn all_adapters() -> Vec<Arc<dyn HarnessAdapter>> {
    ADAPTER_ORDER
        .iter()
        .filter_map(|id| adapters().get(id).cloned())
        .collect()
}

/// On Windows, agent CLIs installed via npm are `.cmd`/`.bat` shims
/// (`claude.cmd`, `kimi.cmd`) which CreateProcess — and therefore both
/// `std::process::Command` and portable-pty — cannot execute directly: the
/// bare name only resolves through a shell's PATHEXT handling. Wrapping in
/// `cmd.exe /C` restores that resolution. Without this, both harness
/// detection and pane spawning silently fail on a stock Windows install.
/// POSIX systems spawn the binary directly.
pub fn resolve_for_spawn(spec: &CommandSpec) -> CommandSpec {
    #[cfg(windows)]
    {
        if spec.program.eq_ignore_ascii_case("cmd.exe") {
            return spec.clone(); // already shell-wrapped (e.g. spawn_shell)
        }
        let mut args = vec!["/C".to_string(), spec.program.clone()];
        args.extend(spec.args.iter().cloned());
        CommandSpec {
            program: "cmd.exe".to_string(),
            args,
        }
    }
    #[cfg(not(windows))]
    {
        spec.clone()
    }
}

// ---------------------------------------------------------------------------
// Safe prompt transport for one-shot turns (M12).
//
// On Windows every spawn goes through `cmd.exe /C` (npm installs the harness
// CLIs as `.cmd` shims, which CreateProcess cannot run directly). cmd.exe
// re-parses the whole command line: `%VAR%` substrings expand even inside
// quotes (mangling prompts that discuss env vars), args without whitespace
// pass UNQUOTED so `a&b` executes `b` as a command, and embedded quotes
// toggle quoting and expose metachars the same way. The shims make it worse
// — their unquoted `%*` re-parses whatever survives. There is NO correct
// escaping for arbitrary text through this chain.
//
// The fix: keep the untrusted prompt OFF every command line.
//   * claude one-shot: `claude -p` reads the prompt from stdin when no
//     prompt arg is given (documented "useful for pipes") — caller pipes it.
//   * kimi / opencode: the prompt travels in the RELAY_TURN_PROMPT env var
//     (the process env block is never cmd-parsed) and a tiny wrapper batch
//     expands it with DELAYED expansion (`!VAR!`), which runs after the
//     percent/metachar phases so the value stays inert — all the way through
//     the shim's own `%*`. Verified empirically on Windows 11 against:
//     `a&b %PATH% say "hi" <tag> | pipe ^caret 100% & calc`, `x"&calc&"y`,
//     and multi-line (LF + CRLF) payloads — all arrive literally, nothing
//     executes. Caveat: embedded `"` chars are consumed by the C runtime's
//     argv parsing at the final node.exe hop (cosmetic, not unsafe).
//
// Flags (model, session ids) are OUR bounded strings and still ride the
// command line as before; only the prompt is untrusted.
// ---------------------------------------------------------------------------

/// Env var carrying the untrusted turn prompt to the wrapper batch.
pub const TURN_PROMPT_ENV: &str = "RELAY_TURN_PROMPT";

/// Harnesses with a one-shot (non-persistent) turn path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnHarness {
    Kimi,
    OpenCode,
    Pi,
    Omp,
    CommandCode,
}

impl TurnHarness {
    fn program(&self) -> &'static str {
        match self {
            TurnHarness::Kimi => "kimi",
            TurnHarness::OpenCode => "opencode",
            TurnHarness::Pi => "pi",
            TurnHarness::Omp => "omp",
            TurnHarness::CommandCode => "commandcode",
        }
    }

    #[cfg(windows)]
    fn wrapper_name(&self) -> &'static str {
        match self {
            TurnHarness::Kimi => "kimi-turn.cmd",
            TurnHarness::OpenCode => "opencode-turn.cmd",
            TurnHarness::Pi => "pi-turn.cmd",
            TurnHarness::Omp => "omp-turn.cmd",
            TurnHarness::CommandCode => "commandcode-turn.cmd",
        }
    }

    /// The constant body of the turn wrapper batch. Only kimi/opencode still
    /// use the `!RELAY_TURN_PROMPT!` delayed-expansion transport — both are
    /// native .exe binaries, and cmd.exe fully expands `!VAR!` on lines whose
    /// command is an exe. Pi/omp/commandcode install as npm .cmd SHIMS: a
    /// batch-to-batch hand-off passes the RAW argument text to the shim,
    /// whose `endLocal … %*` tail re-expands it with delayed expansion OFF,
    /// so the placeholder reached the CLI as a literal string (reproduced
    /// with an argv-dump shim). Those three take the prompt on STDIN instead
    /// (see TurnPromptTransport), so their wrappers only forward our trusted
    /// flags via `%*`.
    #[cfg(windows)]
    fn wrapper_body(&self) -> &'static str {
        match self {
            TurnHarness::Kimi => {
                "@echo off\r\nsetlocal EnableDelayedExpansion\r\nkimi -p \"!RELAY_TURN_PROMPT!\" %*\r\n"
            }
            TurnHarness::OpenCode => {
                "@echo off\r\nsetlocal EnableDelayedExpansion\r\nopencode run --format json --auto %* -- \"!RELAY_TURN_PROMPT!\"\r\n"
            }
            TurnHarness::Pi => "@echo off\r\npi -p --approve --mode json %*\r\n",
            TurnHarness::Omp => "@echo off\r\nomp -p --auto-approve --mode=json %*\r\n",
            TurnHarness::CommandCode => {
                "@echo off\r\ncommandcode -p --output-format json --yolo --tools-all --skip-onboarding --no-auto-update %*\r\n"
            }
        }
    }

    /// Flags-only argv for the stdin-prompt CLIs (the prompt NEVER touches a
    /// command line), or prompt-inline argv for kimi/opencode on POSIX (exec
    /// carries argv verbatim, no shell re-parse).
    fn argv_args(&self, prompt: &str, flags: Vec<String>) -> Vec<String> {
        match self {
            TurnHarness::Kimi => {
                let mut a = vec!["-p".to_string(), prompt.to_string()];
                a.extend(flags);
                a
            }
            TurnHarness::OpenCode => {
                let mut a = vec![
                    "run".to_string(),
                    "--format".to_string(),
                    "json".to_string(),
                    "--auto".to_string(),
                ];
                a.extend(flags);
                a.push("--".to_string());
                a.push(prompt.to_string());
                a
            }
            TurnHarness::Pi | TurnHarness::Omp | TurnHarness::CommandCode => {
                // pi-lineage print mode reads the prompt from stdin when no
                // positional message is given (verified live for all three).
                // omp takes sade-style `--mode=json`; pi space-separated.
                // Full-auto posture by default: pi trusts project-local
                // files for the run (`--approve`) and its print mode already
                // auto-approves tool calls; omp says so explicitly
                // (`--auto-approve`); commandcode gets `--yolo` (bypass
                // permission prompts) plus `--tools-all` (un-withhold every
                // tool in -p mode). `--skip-onboarding` keeps an
                // un-onboarded commandcode account from blocking on the
                // taste wizard, and `--no-auto-update` stops it from
                // self-updating MID-TURN and printing a non-JSON banner into
                // the stream (observed live: "Updated 1.44.0 → 1.45.0" as
                // line 1 of the NDJSON).
                let mut a: Vec<String> = match self {
                    TurnHarness::Pi => {
                        vec!["-p".into(), "--approve".into(), "--mode".into(), "json".into()]
                    }
                    TurnHarness::Omp => {
                        vec!["-p".into(), "--auto-approve".into(), "--mode=json".into()]
                    }
                    _ => vec![
                        "-p".into(),
                        "--output-format".into(),
                        "json".into(),
                        "--yolo".into(),
                        "--tools-all".into(),
                        "--skip-onboarding".into(),
                        "--no-auto-update".into(),
                    ],
                };
                a.extend(flags);
                a
            }
        }
    }
}

/// How the untrusted turn prompt reaches the CLI — `turn_spec` returns this
/// and the caller MUST honor it (piping stdin when told) or the prompt never
/// lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnPromptTransport {
    /// Windows: prompt travels in `RELAY_TURN_PROMPT` + the delayed-
    /// expansion wrapper batch (M12). POSIX: prompt inline in argv. Only
    /// valid for native .exe binaries (kimi/opencode) — see wrapper_body.
    EnvOrArgv,
    /// The parent pipes the prompt to the child's stdin after spawn and
    /// closes the pipe (pi/omp/commandcode print mode). Immune to every
    /// cmd.exe re-parse layer, including npm .cmd shims' `endLocal … %*`.
    Stdin,
}

/// Write the two turn-wrapper batches to a temp dir (idempotent — rewrites
/// only when content differs). Returns the dir, or None if temp is
/// unwritable (callers then fall back to the legacy argv spec).
#[cfg(windows)]
fn ensure_turn_wrappers() -> Option<std::path::PathBuf> {
    let dir = std::env::temp_dir().join("relay-turn-wrappers");
    std::fs::create_dir_all(&dir).ok()?;
    for kind in [TurnHarness::Kimi, TurnHarness::OpenCode, TurnHarness::Pi, TurnHarness::Omp, TurnHarness::CommandCode] {
        let path = dir.join(kind.wrapper_name());
        let body = kind.wrapper_body();
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        if current != body && std::fs::write(&path, body).is_err() {
            return None;
        }
    }
    Some(dir)
}

/// Build the spawn spec for a one-shot turn carrying an untrusted prompt.
/// Returns the spec, the prompt transport the caller MUST honor, and — for
/// [`TurnPromptTransport::EnvOrArgv`] on Windows — the
/// `(TURN_PROMPT_ENV, prompt)` pair to set on the `Command`. The prompt never
/// appears in `spec.args` for any Windows path.
pub fn turn_spec(
    kind: TurnHarness,
    prompt: &str,
    flags: Vec<String>,
) -> (
    CommandSpec,
    Option<(String, String)>,
    TurnPromptTransport,
) {
    // The stdin-prompt CLIs never need a wrapper or an env pair — their argv
    // is flags-only on every platform and the prompt is piped post-spawn.
    if matches!(
        kind,
        TurnHarness::Pi | TurnHarness::Omp | TurnHarness::CommandCode
    ) {
        return (
            resolve_for_spawn(&CommandSpec {
                program: kind.program().to_string(),
                args: kind.argv_args(prompt, flags),
            }),
            None,
            TurnPromptTransport::Stdin,
        );
    }
    #[cfg(windows)]
    {
        if let Some(wrapper) = ensure_turn_wrappers().map(|d| d.join(kind.wrapper_name())) {
            let mut args = vec!["/C".to_string(), wrapper.to_string_lossy().into_owned()];
            args.extend(flags);
            return (
                CommandSpec {
                    program: "cmd.exe".to_string(),
                    args,
                },
                Some((TURN_PROMPT_ENV.to_string(), prompt.to_string())),
                TurnPromptTransport::EnvOrArgv,
            );
        }
        // Wrapper write failed — fall through to the legacy argv spec so the
        // turn still runs (M12 exposure documented in BUG_LIST.md).
    }
    (
        resolve_for_spawn(&CommandSpec {
            program: kind.program().to_string(),
            args: kind.argv_args(prompt, flags),
        }),
        None,
        TurnPromptTransport::EnvOrArgv,
    )
}

/// Runs `<binary> --version` with a short timeout; a clean exit means the
/// harness is installed. Used for the onboarding/Settings status (PRD §9).
/// Spawning `--version` (rather than `where`/`which`) also confirms the binary
/// actually executes on this machine, not just that a file exists on PATH.
pub fn binary_on_path(binary: &str) -> bool {
    use std::process::{Command, Stdio};
    use std::time::Duration;

    let spec = resolve_for_spawn(&CommandSpec::new(binary, &["--version"]));
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // A GUI app spawning a console tool on Windows would otherwise flash a
    // console window for every check.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false, // not found on PATH (or not executable)
    };
    // Poll briefly instead of a blocking wait so a hung shim can't wedge the
    // caller. 5s is generous for `--version`.
    for _ in 0..50 {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => return false,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

// ---- Shared conservative usage scraping -------------------------------------

fn parse_num(s: &str) -> Option<i64> {
    // Harnesses print thousands separators ("1,234"); strip them.
    s.replace(',', "").parse::<i64>().ok()
}

static RE_TOKENS_IN_OUT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)tokens:\s*([\d,]+)\s*in\s*/\s*([\d,]+)\s*out").unwrap()
});
static RE_INPUT_TOKENS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)input[ _-]?tokens?:\s*([\d,]+)").unwrap());
static RE_OUTPUT_TOKENS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)output[ _-]?tokens?:\s*([\d,]+)").unwrap());
static RE_COST: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(?:total\s+)?(?:est(?:imated)?\.?\s+)?cost:\s*\$\s*(\d+(?:\.\d+)?)").unwrap()
});

/// Shared usage parser used by both adapters. Matches lines like
/// "Tokens: 1,234 in / 567 out", "Input tokens: 100", "Total cost: $0.12".
/// Returns None when nothing matched — callers must tolerate that.
pub fn parse_usage_common(output: &str) -> Option<UsageInfo> {
    let mut info = UsageInfo::default();
    if let Some(c) = RE_TOKENS_IN_OUT.captures(output) {
        info.input_tokens = parse_num(&c[1]);
        info.output_tokens = parse_num(&c[2]);
    } else {
        if let Some(c) = RE_INPUT_TOKENS.captures(output) {
            info.input_tokens = parse_num(&c[1]);
        }
        if let Some(c) = RE_OUTPUT_TOKENS.captures(output) {
            info.output_tokens = parse_num(&c[1]);
        }
    }
    if let Some(c) = RE_COST.captures(output) {
        info.cost_usd = c[1].parse::<f64>().ok();
    }
    if info.input_tokens.is_some() || info.output_tokens.is_some() || info.cost_usd.is_some() {
        Some(info)
    } else {
        None
    }
}

// ---- cmd.exe metacharacter guard (E-9c) -------------------------------------
//
// On Windows every harness spawn is wrapped in `cmd.exe /C <shim> %*`, and the
// turn flags (currently `-m <model>`) ride that line UNQUOTED through `%*` —
// cmd re-parses them, so a model id like `a&b` executes `b` as a second
// command. Rather than trying to quote through cmd's `%*` expansion (fragile),
// validate the model id against a conservative allowlist before it reaches a
// spawn line. Real ids (`claude-sonnet-4-5`, `anthropic/claude-3.5-sonnet`,
// `@cf/meta/llama-3.1-8b`, `gpt-4o:latest`, `Qwen2.5-7B-Instruct`) all pass.

/// Reject a model identifier that could act as a command separator when it is
/// forwarded through the cmd.exe `%*` wrapper. Returns `Err(message)` when the
/// id contains anything outside the safe set.
pub fn ensure_cmd_safe_model(model: &str) -> Result<(), String> {
    let ok = |c: char| {
        c.is_ascii_alphanumeric() || "._-@/:+~ ".contains(c)
    };
    if model.chars().all(ok) {
        Ok(())
    } else {
        Err(format!(
            "model id {model:?} contains characters that are not safe to pass \
             through the command wrapper — use a plain model id (letters, \
             digits, . _ - @ / : + ~)"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_model_key_matches_log_ids() {
        assert_eq!(canonical_model_key("claude-sonnet-4-5-20250929"), Some("claude-sonnet-4-5"));
        assert_eq!(canonical_model_key("claude-opus-4-8"), Some("claude-opus-4-8"));
        assert_eq!(canonical_model_key("claude-haiku-4-5-20251001"), Some("claude-haiku-4-5"));
        assert_eq!(canonical_model_key("kimi-k3"), Some("kimi-k3"));
        // Claude Code on this machine maps Anthropic tiers to relay models:
        assert_eq!(canonical_model_key("Kimi-K3[1M]"), Some("kimi-k3"));
        assert_eq!(canonical_model_key("Kimi-K2.6"), Some("kimi-k2.6"));
        assert_eq!(canonical_model_key("Kimi-K2.7"), Some("kimi-k2.7-code"));
        assert_eq!(canonical_model_key("glm-5.2"), Some("glm-5.2"));
        assert_eq!(canonical_model_key("glm-5.1"), Some("glm-5.1"));
        assert_eq!(canonical_model_key("DeepSeek-V4-Pro"), Some("deepseek-v4-pro"));
        assert_eq!(canonical_model_key("minimax-m3"), Some("minimax-m3"));
        assert_eq!(canonical_model_key("qwen3.7-plus"), Some("qwen3.7-plus"));
        assert_eq!(canonical_model_key("some-future-model"), None);
    }

    #[test]
    fn default_rates_cover_all_canonical_keys() {
        for key in [
            "claude-opus-4-8",
            "claude-sonnet-5",
            "claude-sonnet-4-5",
            "claude-haiku-4-5",
            "kimi-k3",
            "kimi-k2.7-code",
            "kimi-k2.6",
            "glm-5.2",
            "glm-5.1",
            "deepseek-v4-pro",
            "minimax-m3",
            "qwen3.7-plus",
        ] {
            let (i, o) = default_rates(key).expect(key);
            assert!(i > 0.0 && o > 0.0, "{key}");
        }
        assert_eq!(default_rates("claude-sonnet-5"), Some((2.0, 10.0)));
        assert_eq!(harness_default_model_key("kimi_code"), "kimi-k3");
        assert_eq!(harness_default_model_key("claude_code"), "claude-sonnet-4-5");
    }

    #[test]
    fn usage_tokens_in_out() {
        let u = parse_usage_common("Tokens: 1,234 in / 567 out").unwrap();
        assert_eq!(u.input_tokens, Some(1234));
        assert_eq!(u.output_tokens, Some(567));
        assert_eq!(u.cost_usd, None);
    }

    #[test]
    fn resolve_for_spawn_wraps_cmd_shims_on_windows() {
        let spec = resolve_for_spawn(&CommandSpec::new("kimi", &["-r", "abc123"]));
        #[cfg(windows)]
        {
            // npm-installed CLIs resolve to `.cmd` shims that CreateProcess
            // cannot execute directly — they must go through cmd.exe.
            assert_eq!(spec.program, "cmd.exe");
            assert_eq!(spec.args, vec!["/C", "kimi", "-r", "abc123"]);
        }
        #[cfg(not(windows))]
        {
            assert_eq!(spec.program, "kimi");
            assert_eq!(spec.args, vec!["-r", "abc123"]);
        }
    }

    #[test]
    #[cfg(windows)]
    fn resolve_for_spawn_does_not_double_wrap_cmd() {
        let spec = resolve_for_spawn(&CommandSpec::new("cmd.exe", &["/C", "npm run dev"]));
        assert_eq!(spec.program, "cmd.exe");
        assert_eq!(spec.args, vec!["/C", "npm run dev"]);
    }

    #[test]
    #[cfg(windows)]
    fn turn_spec_keeps_prompt_off_the_command_line() {
        // M12: the untrusted prompt must travel via env for the exe-binary
        // harnesses, and via stdin for the npm-shim harnesses — never argv.
        let hostile = "a&b %PATH% say \"hi\" <tag> | pipe ^caret 100% & calc";
        for kind in [TurnHarness::Kimi, TurnHarness::OpenCode] {
            let (spec, env, transport) = turn_spec(kind, hostile, vec!["-m".into(), "some-model".into()]);
            assert_eq!(transport, TurnPromptTransport::EnvOrArgv);
            assert_eq!(spec.program, "cmd.exe");
            // No command-line token may contain the prompt text.
            assert!(
                spec.args.iter().all(|a| !a.contains(hostile)),
                "prompt leaked into argv: {:?}",
                spec.args
            );
            // Flags still ride the command line (trusted, Rust-quoted).
            assert!(spec.args.iter().any(|a| a == "some-model"));
            let (key, val) = env.expect("windows turns must use the env transport");
            assert_eq!(key, TURN_PROMPT_ENV);
            assert_eq!(val, hostile);
            // The wrapper itself must use delayed expansion on the env var.
            let wrapper_path = std::path::Path::new(&spec.args[1]);
            let body = std::fs::read_to_string(wrapper_path)
                .unwrap_or_else(|e| panic!("wrapper {} unreadable: {e}", wrapper_path.display()));
            assert!(body.contains("EnableDelayedExpansion"), "{body}");
            assert!(body.contains("!RELAY_TURN_PROMPT!"), "{body}");
            assert!(!body.contains("%RELAY_TURN_PROMPT%"), "{body}");
        }
        // The npm-shim harnesses must NOT use the env transport: a batch→
        // batch hand-off re-expands %* with delayed expansion off (npm shims'
        // `endLocal … %*` tail), which delivered the placeholder literally.
        // Their prompt is piped on stdin; argv is flags-only.
        for kind in [TurnHarness::Pi, TurnHarness::Omp, TurnHarness::CommandCode] {
            let (spec, env, transport) = turn_spec(kind, hostile, vec!["-m".into(), "some-model".into()]);
            assert_eq!(transport, TurnPromptTransport::Stdin, "{kind:?}");
            assert!(env.is_none(), "{kind:?}");
            assert!(
                spec.args.iter().all(|a| !a.contains(hostile) && !a.contains("RELAY_TURN_PROMPT")),
                "prompt/placeholder leaked into argv: {:?}",
                spec.args
            );
            assert!(spec.args.iter().any(|a| a == "some-model"), "{kind:?}");
        }
    }

    #[test]
    #[cfg(windows)]
    fn pi_turn_wrapper_is_flags_only() {
        // pi/omp/commandcode wrappers forward only our trusted flags — the
        // prompt arrives on stdin, so no placeholder may appear.
        for kind in [TurnHarness::Pi, TurnHarness::Omp, TurnHarness::CommandCode] {
            let (spec, _, transport) = turn_spec(kind, "prompt text", vec!["-m".into(), "some-model".into()]);
            assert_eq!(transport, TurnPromptTransport::Stdin);
            assert!(
                spec.args.iter().all(|a| !a.contains("RELAY_TURN_PROMPT") && !a.contains("prompt text")),
                "prompt leaked into argv: {:?}",
                spec.args
            );
            let body = kind.wrapper_body();
            assert!(body.contains("%*"), "{body}");
            assert!(!body.contains("RELAY_TURN_PROMPT"), "{body}");
        }
    }

    #[test]
    #[cfg(not(windows))]
    fn pi_omp_posix_argv_shapes() {
        // POSIX: the stdin-prompt CLIs still get flags-only argv, with the
        // full-auto posture baked in (--approve / --auto-approve).
        let (spec, env, transport) = turn_spec(TurnHarness::Pi, "hello", vec!["-m".into(), "some-model".into()]);
        assert_eq!(transport, TurnPromptTransport::Stdin);
        assert!(env.is_none());
        assert_eq!(spec.program, "pi");
        assert_eq!(spec.args, vec!["-p", "--approve", "--mode", "json", "-m", "some-model"]);
        let (omp, omp_env, omp_transport) = turn_spec(TurnHarness::Omp, "hello", vec!["-m".into(), "some-model".into()]);
        assert_eq!(omp_transport, TurnPromptTransport::Stdin);
        assert!(omp_env.is_none());
        assert_eq!(omp.program, "omp");
        assert_eq!(omp.args, vec!["-p", "--auto-approve", "--mode=json", "-m", "some-model"]);
    }

    #[test]
    #[cfg(windows)]
    fn wrapper_batch_transports_hostile_prompt_literally() {
        // End-to-end canary for the cmd.exe parse chain: a probe shim records
        // its %* exactly as received; the payload must arrive byte-identical
        // and NOTHING may execute. Mirrors the manual verification from the
        // M12 fix (would catch a cmd behavior change on another Windows
        // version).
        let dir = std::env::temp_dir().join(format!("relay-m12-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.txt");
        let shim = dir.join("probe.cmd");
        let wrapper = dir.join("wrapper.cmd");
        std::fs::write(
            &shim,
            "@echo off\r\necho star=[%*] > \"%~dp0out.txt\"\r\necho survived >> \"%~dp0out.txt\"\r\n",
        )
        .unwrap();
        std::fs::write(
            &wrapper,
            format!(
                "@echo off\r\nsetlocal EnableDelayedExpansion\r\n\"{}\" -p \"!P!\"\r\n",
                shim.to_string_lossy()
            ),
        )
        .unwrap();

        let payload = "a&b %PATH% say \"hi\" <tag> | pipe ^caret 100% & calc\r\nsecond line";
        let status = std::process::Command::new("cmd.exe")
            .args(["/C", &wrapper.to_string_lossy()])
            .env("P", payload)
            .status()
            .unwrap();
        assert!(status.success());

        let got = std::fs::read_to_string(&out).unwrap();
        // The probe's echo shows %* verbatim; the payload must be there in
        // full (quotes retained around it) followed by the survivor line.
        assert!(got.contains(payload), "payload mangled:\n{got}");
        assert!(got.contains("survived"), "command split executed:\n{got}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn usage_separate_token_lines() {
        let u = parse_usage_common("Input tokens: 42\nOutput tokens: 7").unwrap();
        assert_eq!(u.input_tokens, Some(42));
        assert_eq!(u.output_tokens, Some(7));
    }

    #[test]
    fn usage_total_cost() {
        let u = parse_usage_common("Total cost: $0.12").unwrap();
        assert_eq!(u.cost_usd, Some(0.12));
        assert_eq!(u.input_tokens, None);
    }

    #[test]
    fn usage_cost_without_total_prefix() {
        let u = parse_usage_common("cost: $1.50").unwrap();
        assert_eq!(u.cost_usd, Some(1.50));
    }

    #[test]
    fn usage_nothing_matched() {
        assert!(parse_usage_common("hello world, no stats here").is_none());
        assert!(parse_usage_common("").is_none());
    }

    #[test]
    fn registry_has_all_adapters() {
        for id in [
            "claude_code",
            "kimi_code",
            "opencode",
            "pi",
            "omp",
            "commandcode",
        ] {
            assert!(get_adapter(id).is_some(), "{id} missing from registry");
        }
        assert!(get_adapter("nope").is_none());
        // The presentation order covers every registered adapter — a new
        // adapter added without an ADAPTER_ORDER entry would vanish from
        // list_harnesses.
        assert_eq!(all_adapters().len(), adapters().len());
    }

    #[test]
    fn cmd_safe_model_allows_real_ids() {
        for id in [
            "claude-sonnet-4-5",
            "anthropic/claude-3.5-sonnet",
            "@cf/meta/llama-3.1-8b",
            "gpt-4o:latest",
            "Qwen2.5-7B-Instruct",
        ] {
            assert!(ensure_cmd_safe_model(id).is_ok(), "{id} should pass");
        }
    }

    #[test]
    fn cmd_safe_model_rejects_metacharacters() {
        for id in ["a&b", "x|y", "$(rm -rf)", "a>b", "100%^", "a!b", "a\nb"] {
            assert!(ensure_cmd_safe_model(id).is_err(), "{id} must be rejected");
        }
    }
}
