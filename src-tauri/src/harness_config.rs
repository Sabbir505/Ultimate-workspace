//! Reads each CLI harness's OWN configuration to discover the models and
//! endpoints the user actually has set up (mockup 02: the static catalog in
//! `src/lib/harnessModels.ts` can lie when a CLI is pointed at a custom
//! endpoint with custom model ids — which is the norm, not the exception).
//!
//! Config locations (verified on a stock Windows install):
//! - Claude Code: `~/.claude/settings.json` — `model`, plus `env` overrides
//!   (`ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_<ALIAS>_MODEL(_NAME)`) used by
//!   relay setups to remap the built-in aliases to custom upstream models.
//!   The same env block carries the CLI's own effort level
//!   (`CLAUDE_CODE_EFFORT_LEVEL`), read read-only for the picker.
//! - Kimi CLI: `~/.kimi-code/config.toml` — `default_model`, `[providers.*]`
//!   with `base_url`, `[models."<id>"]` entries with `display_name`.
//! - OpenCode: `~/.config/opencode/opencode.json` — `model` ("provider/id"),
//!   `provider.<id>.options.baseURL`, `provider.<id>.models` map.
//!
//! Everything is best-effort: a missing/unparseable config just yields an
//! empty result and the frontend falls back to the static catalog.

use serde::Serialize;
use serde_json::Value;

use crate::agent_sessions::EFFORT_TIERS;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModelInfo {
    /// Value passed to the CLI (`claude --model <id>`, `kimi -m <id>`, …).
    pub id: String,
    /// Human label for the dropdown (display_name / NAME override / raw id).
    pub label: String,
    /// "config" = discovered in the CLI's own config; "cli" = listed live by
    /// the CLI itself (e.g. `opencode models`: Zen + free registry models);
    /// "builtin" = CLI default.
    pub source: &'static str,
    /// Thinking levels THIS model supports, as reported by the CLI
    /// (omp's `models --json` dump). Empty = no per-model report; the picker
    /// then falls back to the harness-wide `effort_options`. Ordered by
    /// [`tier_rank`] so the slider reads weakest → strongest.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub thinking: Vec<String>,
}

impl HarnessModelInfo {
    fn new(id: String, label: String, source: &'static str) -> Self {
        Self {
            id,
            label,
            source,
            thinking: Vec::new(),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModelConfig {
    /// The CLI's configured default model id, when the config names one.
    pub default_model: Option<String>,
    /// Custom endpoint the CLI is pointed at (ANTHROPIC_BASE_URL / base_url /
    /// baseURL), shown in the dropdown so relay setups are visible.
    pub endpoint: Option<String>,
    /// Reasoning-effort level the CLI will run with, READ-ONLY — surfaced in
    /// the agent picker so the harness pane shows what turns will actually
    /// use. Only some CLIs publish one (Claude Code via its settings' env
    /// block); None just means "the CLI doesn't expose a level".
    pub effort: Option<String>,
    /// Effort/thinking tiers the CLI can be SPAWNED with (the session's
    /// per-session tier is applied by agent_sessions at each spawn: claude
    /// `--effort`, omp/pi `--thinking`, kimi env). Ordered weakest →
    /// strongest; the picker prepends "Default". Empty = no knob.
    pub effort_options: Vec<String>,
    pub models: Vec<HarnessModelInfo>,
}

pub fn harness_model_config(harness_id: &str) -> HarnessModelConfig {
    let mut cfg = match harness_id {
        "claude_code" => claude_config(),
        "kimi_code" => kimi_config(),
        "opencode" => opencode_config(),
        "pi" => pi_config(),
        "omp" => omp_config(),
        "commandcode" => commandcode_config(),
        _ => HarnessModelConfig::default(),
    };
    // Spawn-time effort tiers this CLI accepts (agent_sessions applies the
    // session's pick). Empty = the harness exposes no knob and the picker
    // keeps its pane slider-free.
    cfg.effort_options = effort_options_for(harness_id)
        .unwrap_or(&[])
        .iter()
        .map(|s| s.to_string())
        .collect();
    // The default model always appears in the list, even if the config names
    // one we didn't otherwise discover.
    if let Some(def) = cfg.default_model.clone() {
        if !cfg.models.iter().any(|m| m.id == def) {
            cfg.models.insert(
                0,
                HarnessModelInfo::new(def.clone(), def, "config"),
            );
        }
    }
    cfg
}

/// Per-harness effort vocabulary, weakest → strongest — exactly what each CLI
/// documents and what `agent_sessions` passes at spawn:
/// - claude `--effort low|medium|high|xhigh|max` (native flag, verified
///   against `claude --help`)
/// - kimi `KIMI_MODEL_THINKING_EFFORT low|medium|high` — the CLI migrated
///   "max" away (`migrations-effort.json: thinking-effort-max-to-high`), so
///   "high" is its ceiling
/// - omp/pi `--thinking off|minimal|low|medium|high|xhigh|max` (identical
///   vocabularies, both documented in `--help`)
fn effort_options_for(harness_id: &str) -> Option<&'static [&'static str]> {
    match harness_id {
        "claude_code" => Some(&["low", "medium", "high", "xhigh", "max"]),
        "kimi_code" => Some(&["low", "medium", "high"]),
        "omp" | "pi" => Some(&[
            "off", "minimal", "low", "medium", "high", "xhigh", "max",
        ]),
        _ => None,
    }
}

/// Canonical ordering position of a thinking tier (weakest → strongest).
/// Unknown tiers sort last, preserving their relative order — a CLI adding a
/// tier we don't know yet must still render, just at the end.
fn tier_rank(tier: &str) -> usize {
    EFFORT_TIERS
        .iter()
        .position(|t| *t == tier)
        .unwrap_or(EFFORT_TIERS.len())
}

/// The union of every model's reported thinking tiers, deduped and ordered
/// weakest → strongest — the slider offer when the session's exact model has
/// no per-model report of its own.
pub fn union_thinking_tiers(models: &[HarnessModelInfo]) -> Vec<String> {
    let mut tiers: Vec<String> = Vec::new();
    for m in models {
        for t in &m.thinking {
            if !tiers.iter().any(|x| x == t) {
                tiers.push(t.clone());
            }
        }
    }
    tiers.sort_by_key(|t| tier_rank(t));
    tiers
}

impl Default for HarnessModelConfig {
    fn default() -> Self {
        Self {
            default_model: None,
            endpoint: None,
            effort: None,
            effort_options: vec![],
            models: vec![],
        }
    }
}

fn read_json(path: std::path::PathBuf) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Display label for a remapped Claude alias. `name` is the human name
/// (`ANTHROPIC_DEFAULT_<ALIAS>_MODEL_NAME`), `mapped` the upstream model id.
/// The parenthetical is only useful when they differ — relays often set both
/// to the same string, which would render as "deepseek v4 flash (deepseek
/// v4 flash)".
fn remap_label(name: &str, mapped: &str) -> String {
    if name.eq_ignore_ascii_case(mapped) {
        name.to_string()
    } else {
        format!("{name} ({mapped})")
    }
}

// ---------------------------------------------------------------- Claude Code

/// Claude's aliases are the values `--model` accepts; relay setups remap them
/// via `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` (+ a human `_NAME` counterpart).
fn claude_config() -> HarnessModelConfig {
    let mut cfg = HarnessModelConfig::default();
    let Some(home) = crate::util::home_dir() else { return cfg };
    let Some(j) = read_json(home.join(".claude").join("settings.json")) else {
        return cfg;
    };
    cfg.default_model = j
        .get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());
    let env = j.get("env").cloned().unwrap_or(Value::Null);
    let env_s = |k: &str| env.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    cfg.endpoint = env_s("ANTHROPIC_BASE_URL");
    cfg.effort = claude_effort_from_env(&env);

    for alias in ["fable", "opus", "sonnet", "haiku"] {
        let up = alias.to_uppercase();
        let mapped = env_s(&format!("ANTHROPIC_DEFAULT_{up}_MODEL"));
        let name = env_s(&format!("ANTHROPIC_DEFAULT_{up}_MODEL_NAME"));
        match (&mapped, &name) {
            (Some(m), Some(n)) => cfg.models.push(HarnessModelInfo::new(
                alias.to_string(),
                remap_label(n, m),
                "config",
            )),
            (Some(m), None) => cfg.models.push(HarnessModelInfo::new(
                alias.to_string(),
                m.clone(),
                "config",
            )),
            // No remap: the alias is a CLI built-in pointing at Anthropic's
            // latest of that family.
            _ => cfg.models.push(HarnessModelInfo::new(
                alias.to_string(),
                capitalize(alias),
                "builtin",
            )),
        }
    }
    cfg
}

/// The CLI's configured effort level, read from its settings' `env` block.
/// Kept stringly (the CLI owns the vocabulary — "max" is a real value here,
/// which doesn't map onto the provider slider's low/medium/high tiers); the
/// frontend shows it verbatim, read-only.
fn claude_effort_from_env(env: &Value) -> Option<String> {
    env.get("CLAUDE_CODE_EFFORT_LEVEL")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

// ---------------------------------------------------------------- Kimi CLI

fn kimi_config() -> HarnessModelConfig {
    let mut cfg = HarnessModelConfig::default();
    let Some(home) = crate::util::home_dir() else { return cfg };
    let Ok(text) = std::fs::read_to_string(home.join(".kimi-code").join("config.toml")) else {
        return cfg;
    };
    let Ok(t) = text.parse::<toml::Value>() else { return cfg };
    cfg.default_model = t
        .get("default_model")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    let base_url_of = |provider: &str| {
        t.get("providers")
            .and_then(|p| p.get(provider))
            .and_then(|p| p.get("base_url"))
            .and_then(|u| u.as_str())
            .map(|s| s.to_string())
    };

    if let Some(models) = t.get("models").and_then(|m| m.as_table()) {
        // Deterministic order: default model first, then alphabetical.
        let mut entries: Vec<_> = models.iter().collect();
        entries.sort_by_key(|(id, _)| {
            (Some(id.as_str()) != cfg.default_model.as_deref(), id.as_str().to_string())
        });
        for (id, m) in entries {
            let label = m
                .get("display_name")
                .and_then(|d| d.as_str())
                .unwrap_or(id)
                .to_string();
            if cfg.endpoint.is_none() {
                cfg.endpoint = m
                    .get("provider")
                    .and_then(|p| p.as_str())
                    .and_then(base_url_of);
            }
            cfg.models.push(HarnessModelInfo::new(id.clone(), label, "config"));
        }
    }
    cfg
}

// ---------------------------------------------------------------- OpenCode

/// OpenCode's own config file (opencode.json / opencode.jsonc under
/// ~/.config/opencode). Bare-id model resolution reads it directly — no
/// `opencode models` live probe, which would stall the send path for seconds.
fn opencode_config_json() -> Option<Value> {
    let home = crate::util::home_dir()?;
    let dir = home.join(".config").join("opencode");
    read_json(dir.join("opencode.json")).or_else(|| read_json(dir.join("opencode.jsonc")))
}

/// Map a bare model id ("glm-5.2") to OpenCode's provider-qualified selector
/// ("sharkai/glm-5.2") using the opencode.json config. OpenCode — both the
/// persistent server's per-message model override and `run -m` — only accepts
/// "provider/model": a bare id is silently dropped and the CLI's configured
/// default serves the turn instead, which read as "changing the model does
/// nothing". Ties between providers carrying the same bare id prefer the
/// config's default model's provider. Returns the input unchanged when it
/// already carries a provider, or when nothing in the config matches (the
/// caller's behavior then matches the old pass-through).
pub fn resolve_opencode_model(model: &str) -> String {
    if model.is_empty() || model.contains('/') {
        return model.to_string();
    }
    match opencode_config_json().as_ref().and_then(|j| resolve_opencode_model_in(j, model)) {
        Some(qualified) => qualified,
        None => model.to_string(),
    }
}

/// Pure core of [`resolve_opencode_model`] over a parsed config — unit-testable
/// without touching the real home dir.
fn resolve_opencode_model_in(cfg: &Value, model: &str) -> Option<String> {
    let providers = cfg.get("provider")?.as_object()?;
    let mut hits: Vec<String> = Vec::new();
    for (pid, p) in providers {
        let Some(models) = p.get("models").and_then(|m| m.as_object()) else {
            continue;
        };
        if models.contains_key(model) {
            hits.push(pid.clone());
        }
    }
    hits.sort();
    let default_provider = cfg
        .get("model")
        .and_then(|m| m.as_str())
        .and_then(|m| m.split('/').next())
        .map(String::from);
    let pick = hits
        .iter()
        .find(|pid| default_provider.as_deref() == Some(pid.as_str()))
        .or_else(|| hits.first())?;
    Some(format!("{pick}/{model}"))
}

fn opencode_config() -> HarnessModelConfig {
    let mut cfg = HarnessModelConfig::default();
    let Some(home) = crate::util::home_dir() else { return cfg };
    let dir = home.join(".config").join("opencode");
    let j = read_json(dir.join("opencode.json"))
        .or_else(|| read_json(dir.join("opencode.jsonc")));
    let Some(j) = j else { return cfg };
    cfg.default_model = j
        .get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    if let Some(providers) = j.get("provider").and_then(|p| p.as_object()) {
        for (pid, p) in providers {
            if cfg.endpoint.is_none() {
                cfg.endpoint = p
                    .pointer("/options/baseURL")
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string());
            }
            if let Some(models) = p.get("models").and_then(|m| m.as_object()) {
                for (mid, m) in models {
                    let label = m
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or(mid)
                        .to_string();
                    cfg.models.push(HarnessModelInfo::new(
                        format!("{pid}/{mid}"),
                        label,
                        "config",
                    ));
                }
            }
        }
    }

    // The config only names the user's own providers — OpenCode also ships
    // its own registry (Zen subscription models + free models) which only
    // shows up in the live `opencode models` list. Merge anything the config
    // didn't already give us.
    let known: std::collections::HashSet<String> =
        cfg.models.iter().map(|m| m.id.clone()).collect();
    for id in opencode_live_models() {
        if !known.contains(&id) {
            cfg.models.push(HarnessModelInfo::new(
                id.rsplit('/').next().unwrap_or(&id).to_string(),
                id.clone(),
                "cli",
            ));
        }
    }
    cfg
}

/// Live model list from `opencode models` (one "provider/model" id per
/// line). Best-effort with a short timeout — an uninstalled/hung CLI just
/// yields nothing and the config-derived list stands.
fn opencode_live_models() -> Vec<String> {
    capture_cli_stdout("opencode", &["models"], 80)
        .map(|out| {
            out.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| l.contains('/') && !l.contains(' '))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------- Pi / Omp
//
// Both are pi-lineage CLIs (omp is a pi fork). pi keeps user config as JSON
// under `~/.pi/agent/` (settings.json for the default model, models.json for
// custom providers); omp uses `~/.omp/agent/*.yml`, which we deliberately do
// NOT parse (no YAML dependency for one file) — its models come from the
// live `omp models --json` dump instead.

fn pi_config() -> HarnessModelConfig {
    let mut cfg = HarnessModelConfig::default();
    let Some(home) = crate::util::home_dir() else { return cfg };
    let dir = home.join(".pi").join("agent");

    // settings.json: `defaultProvider` + `defaultModel` (verified against the
    // CLI's docs/settings.md). Prefix the provider when the model id is bare
    // so the stored id is the unambiguous "provider/model" selector.
    if let Some(j) = read_json(dir.join("settings.json")) {
        cfg.default_model = j.get("defaultModel").and_then(|m| m.as_str()).map(String::from);
        if let (Some(dm), Some(dp)) = (
            cfg.default_model.clone(),
            j.get("defaultProvider").and_then(|p| p.as_str()),
        ) {
            if !dm.contains('/') && !dp.is_empty() {
                cfg.default_model = Some(format!("{dp}/{dm}"));
            }
        }
    }

    // models.json: custom providers (relays, Ollama, …) — `baseUrl` feeds the
    // endpoint display, `models[].id` the list (ids stored as "provider/id",
    // the selector `--model` accepts).
    if let Some(j) = read_json(dir.join("models.json")) {
        if let Some(providers) = j.get("providers").and_then(|p| p.as_object()) {
            for (pid, p) in providers {
                if cfg.endpoint.is_none() {
                    cfg.endpoint = p.get("baseUrl").and_then(|u| u.as_str()).map(String::from);
                }
                if let Some(models) = p.get("models").and_then(|m| m.as_array()) {
                    for m in models {
                        let Some(mid) = m.get("id").and_then(|i| i.as_str()) else { continue };
                        let label = m
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or(mid)
                            .to_string();
                        cfg.models.push(HarnessModelInfo::new(
                            format!("{pid}/{mid}"),
                            label,
                            "config",
                        ));
                    }
                }
            }
        }
    }

    // Live `pi --list-models` covers the authenticated built-in catalog the
    // config files don't name.
    let known: std::collections::HashSet<String> =
        cfg.models.iter().map(|m| m.id.clone()).collect();
    if let Some(out) = capture_cli_stdout("pi", &["--list-models"], 100) {
        for (id, label) in parse_pi_models_table(&out) {
            if !known.contains(&id) {
                cfg.models.push(HarnessModelInfo::new(id, label, "cli"));
            }
        }
    }
    cfg
}

/// Parse `pi --list-models` output into ("provider/model", label) pairs.
/// Table rows are whitespace-padded columns:
/// `provider model context max-out thinking images` — requiring a
/// context-size token in the third column keeps prose lines ("No models
/// available. Use /login to log into a provider via OAuth or API key. See:")
/// and file paths out of the result. (Verified against a real authenticated
/// listing; chalk disables ANSI when piped.)
fn parse_pi_models_table(out: &str) -> Vec<(String, String)> {
    let mut rows = Vec::new();
    for line in out.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() != 6 || tokens[0] == "provider" {
            continue;
        }
        let is_context = tokens[2]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit());
        if !is_context {
            continue;
        }
        rows.push((format!("{}/{}", tokens[0], tokens[1]), tokens[1].to_string()));
    }
    rows
}

/// Live `omp models --json` — `{"models":[{provider,id,selector,name,…}]}`.
/// The `selector` ("provider/id") is exactly what `--model` accepts.
fn omp_config() -> HarnessModelConfig {
    let mut cfg = HarnessModelConfig::default();
    let Some(out) = capture_cli_stdout("omp", &["models", "--json"], 100) else {
        return cfg;
    };
    cfg.models = parse_omp_models_json(&out);
    cfg
}

/// Live `commandcode --list-models` — a padded two-column table
/// (`<provider/id><pad><description>`) with section headers and a trailing
/// ` (default)` marker on the account's default model. (Verified against a
/// real authenticated listing; the CLI offers no --json form.) Rows require a
/// `/` in the id so headers ("Open Source", "Available models · 67 models")
/// never parse as models.
fn commandcode_config() -> HarnessModelConfig {
    match capture_cli_stdout("commandcode", &["--list-models"], 150) {
        Some(out) => commandcode_config_from(&out),
        None => HarnessModelConfig::default(),
    }
}

fn commandcode_config_from(out: &str) -> HarnessModelConfig {
    let mut cfg = HarnessModelConfig::default();
    for line in out.lines() {
        let Some((id, label)) = line.split_once("  ") else { continue };
        let id = id.trim();
        if !id.contains('/') || id.contains(' ') {
            continue;
        }
        let label = label.trim();
        if label == "(default)" {
            // Empty description, only the marker — still list the model.
            cfg.default_model = Some(id.to_string());
            cfg.models.push(HarnessModelInfo::new(
                id.to_string(),
                id.rsplit('/').next().unwrap_or(id).to_string(),
                "cli",
            ));
            continue;
        }
        if let Some(base) = label.strip_suffix(" (default)") {
            cfg.default_model = Some(id.to_string());
            cfg.models.push(HarnessModelInfo::new(
                id.to_string(),
                base.trim().to_string(),
                "cli",
            ));
            continue;
        }
        cfg.models.push(HarnessModelInfo::new(
            id.to_string(),
            label.to_string(),
            "cli",
        ));
    }
    cfg
}

/// Parse `omp models --json` into model rows. omp's own provider config is
/// YAML (`~/.omp/agent/models.yml`), which we deliberately don't parse — the
/// live dump already reflects it. Unparseable output yields an empty list
/// rather than garbage rows. Each model's reported `thinking` tier array
/// rides along (ordered weakest → strongest) — the picker narrows its slider
/// to the selected model's own offer when the dump provides one.
fn parse_omp_models_json(out: &str) -> Vec<HarnessModelInfo> {
    let Ok(j) = serde_json::from_str::<serde_json::Value>(out) else {
        return Vec::new();
    };
    let Some(list) = j.get("models").and_then(|m| m.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|m| {
            let id = m
                .get("selector")
                .and_then(|s| s.as_str())
                .map(String::from)
                .or_else(|| {
                    let provider = m.get("provider").and_then(|p| p.as_str())?;
                    let id = m.get("id").and_then(|i| i.as_str())?;
                    Some(format!("{provider}/{id}"))
                })?;
            let label = m
                .get("name")
                .and_then(|n| n.as_str())
                .map(String::from)
                .unwrap_or_else(|| id.rsplit('/').next().unwrap_or(&id).to_string());
            let mut info = HarnessModelInfo::new(id, label, "cli");
            if let Some(tiers) = m.get("thinking").and_then(|t| t.as_array()) {
                let mut names: Vec<String> = tiers
                    .iter()
                    .filter_map(|t| t.as_str().map(String::from))
                    .collect();
                names.sort_by_key(|t| tier_rank(t));
                info.thinking = names;
            }
            Some(info)
        })
        .collect()
}

/// Spawn a harness CLI, drain stdout on a background thread (a full OS pipe
/// buffer would otherwise deadlock the child — same pattern as git.rs's run_git
/// drain threads), and return its output once it exits within `ticks` × 100ms.
/// A missing/hung CLI yields None; callers must treat that as "no models".
fn capture_cli_stdout(program: &str, args: &[&str], ticks: u32) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    let spec = crate::harness_adapters::resolve_for_spawn(&crate::harness_adapters::CommandSpec::new(program, args));
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // A GUI app spawning a console tool on Windows would otherwise flash a
    // console window.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout_pipe = child
        .stdout
        .take()
        .expect("piped stdout is present right after spawn");
    // The drain writes bytes into a shared buffer INCREMENTALLY and signals
    // EOF separately — so output captured so far is retrievable even while an
    // orphaned process still holds the pipe open (see terminate_capture).
    let captured: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let (eof_tx, eof_rx) = mpsc::channel::<()>();
    let captured_for_thread = Arc::clone(&captured);
    // Deliberately detached: completion is observed via `eof_rx`, and a
    // bounded wait must never be turned back into an unconditional join.
    let _drain = std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match stdout_pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut c) = captured_for_thread.lock() {
                        c.extend_from_slice(&buf[..n]);
                    }
                }
            }
        }
        let _ = eof_tx.send(());
    });
    for _ in 0..ticks {
        match child.try_wait() {
            Ok(Some(_)) => return terminate_capture(&mut child, eof_rx, &captured),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => {
                terminate_capture(&mut child, eof_rx, &captured);
                return None;
            }
        }
    }
    terminate_capture(&mut child, eof_rx, &captured);
    None
}

/// Kill the CLI's whole process tree, then collect the drain output with a
/// BOUNDED wait. Three traps this avoids:
///   1. On Windows the direct child is usually a `cmd.exe /C` wrapper
///      (`resolve_for_spawn`), so killing only it leaves the real CLI
///      grandchild holding the stdout pipe — a plain `join()` would then
///      block on an EOF that never comes.
///   2. When the direct child already EXITED, its orphaned grandchildren are
///      unreachable by any parent-walk — the pipe can stay open long after.
///      Hence the bounded EOF wait and the PARTIAL output from the shared
///      buffer: bytes already captured are returned even without EOF.
///   3. A hung drain (unkillable process, stuck pipe) must never wedge the
///      model-listing command — one leaked reader thread is cheaper.
fn terminate_capture(
    child: &mut std::process::Child,
    eof_rx: std::sync::mpsc::Receiver<()>,
    captured: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
) -> Option<String> {
    crate::agent_sessions::kill_child_tree(child);
    let _ = eof_rx.recv_timeout(std::time::Duration::from_secs(3));
    let bytes = captured
        .lock()
        .map(|c| c.clone())
        .unwrap_or_default();
    if bytes.is_empty() {
        None
    } else {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remap_label_dedupes_identical_name_and_id() {
        // The relay bug: NAME and MODEL both "deepseek v4 flash" → label must
        // not render "deepseek v4 flash (deepseek v4 flash)".
        assert_eq!(remap_label("deepseek v4 flash", "deepseek v4 flash"), "deepseek v4 flash");
        // Case differences are still the same model name.
        assert_eq!(remap_label("DeepSeek V4 Flash", "deepseek v4 flash"), "DeepSeek V4 Flash");
    }

    #[test]
    fn remap_label_keeps_parenthetical_when_names_differ() {
        // Different name + id keeps the disambiguating parenthetical.
        assert_eq!(remap_label("Sonnet", "kimi-k2.6"), "Sonnet (kimi-k2.6)");
        assert_eq!(remap_label("Opus", "glm-5.2"), "Opus (glm-5.2)");
    }

    #[test]
    fn claude_effort_reads_the_settings_env_block() {
        // Shape mirrors a real settings.json (this machine carries "max").
        let env: Value = serde_json::from_str(
            r#"{"ANTHROPIC_BASE_URL":"https://relay.example","CLAUDE_CODE_EFFORT_LEVEL":"max"}"#,
        )
        .unwrap();
        assert_eq!(claude_effort_from_env(&env).as_deref(), Some("max"));
    }

    #[test]
    fn claude_effort_absent_or_blank_is_none() {
        // No env block at all — the common case — must read as "no level",
        // not an error.
        assert_eq!(claude_effort_from_env(&Value::Null), None);
        assert_eq!(claude_effort_from_env(&serde_json::json!({})), None);
        // A blank string is as good as unset.
        assert_eq!(
            claude_effort_from_env(&serde_json::json!({"CLAUDE_CODE_EFFORT_LEVEL": "  "})),
            None
        );
        // Non-string values are ignored rather than stringified.
        assert_eq!(
            claude_effort_from_env(&serde_json::json!({"CLAUDE_CODE_EFFORT_LEVEL": 3})),
            None
        );
    }

    #[test]
    fn parse_pi_models_table_real_listing() {
        // Captured verbatim from `pi --list-models` on a configured machine
        // (relay provider + three models).
        let out = "provider  model              context  max-out  thinking  images\n\
                   sharkai   deepseek-v4-flash  128K     16.4K    no        no    \n\
                   sharkai   glm-5.2            128K     16.4K    no        no    \n\
                   sharkai   mimo-v2.5          128K     16.4K    no        no    \n";
        let rows = parse_pi_models_table(out);
        assert_eq!(
            rows,
            vec![
                ("sharkai/deepseek-v4-flash".to_string(), "deepseek-v4-flash".to_string()),
                ("sharkai/glm-5.2".to_string(), "glm-5.2".to_string()),
                ("sharkai/mimo-v2.5".to_string(), "mimo-v2.5".to_string()),
            ]
        );
    }

    #[test]
    fn parse_pi_models_table_ignores_prose_and_header() {
        // The unauthenticated listing is prose, not a table — must parse to
        // nothing rather than inventing rows out of the sentence.
        let out = "No models available. Use /login to log into a provider via OAuth or API key. See:\n\
                   C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\docs\\providers.md\n\
                   provider  model  context  max-out  thinking  images\n";
        assert!(parse_pi_models_table(out).is_empty());
    }

    #[test]
    fn parse_omp_models_json_real_dump() {
        // Shape captured verbatim from `omp models --json` ( Bun 1.4 / omp 18).
        let out = r#"{"models":[{"provider":"sharkai","id":"glm-5.2","selector":"sharkai/glm-5.2","name":"GLM 5.2","contextWindow":1048576,"maxTokens":131072,"reasoning":true,"thinking":["max","low","minimal"],"input":["text"],"cost":{"input":0.14,"output":0.28}}"#;
        let out = format!("{out}]}}");
        let rows = parse_omp_models_json(&out);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "sharkai/glm-5.2");
        assert_eq!(rows[0].label, "GLM 5.2");
        assert_eq!(rows[0].source, "cli");
        // The dump's per-model thinking tiers ride along, reordered weakest →
        // strongest for the slider (the dump itself is unordered).
        assert_eq!(rows[0].thinking, vec!["minimal", "low", "max"]);
    }

    #[test]
    fn effort_options_follow_the_documented_cli_vocabularies() {
        assert_eq!(
            effort_options_for("claude_code"),
            Some(&["low", "medium", "high", "xhigh", "max"][..])
        );
        // kimi retired "max" (migrations-effort.json: max-to-high) — "high"
        // is its ceiling.
        assert_eq!(
            effort_options_for("kimi_code"),
            Some(&["low", "medium", "high"][..])
        );
        // pi and omp document the identical --thinking vocabulary.
        assert_eq!(effort_options_for("omp"), effort_options_for("pi"));
        // No knob → no options → the picker keeps the pane slider-free.
        assert_eq!(effort_options_for("opencode"), None);
        assert_eq!(effort_options_for("commandcode"), None);
        assert_eq!(effort_options_for("nonexistent"), None);
    }

    #[test]
    fn union_thinking_tiers_dedupes_and_orders() {
        let models = vec![
            {
                let mut m = HarnessModelInfo::new("a/x".into(), "X".into(), "cli");
                m.thinking = vec!["high".into(), "minimal".into()];
                m
            },
            {
                let mut m = HarnessModelInfo::new("b/y".into(), "Y".into(), "cli");
                m.thinking = vec!["off".into(), "high".into(), "unknown-tier".into()];
                m
            },
            HarnessModelInfo::new("c/z".into(), "Z".into(), "cli"),
        ];
        assert_eq!(
            union_thinking_tiers(&models),
            vec![
                "off".to_string(),
                "minimal".to_string(),
                "high".to_string(),
                "unknown-tier".to_string(),
            ]
        );
    }

    #[test]
    fn parse_omp_models_json_tolerates_garbage() {
        assert!(parse_omp_models_json("not json at all").is_empty());
        assert!(parse_omp_models_json("{}").is_empty());
    }

    #[test]
    fn parse_commandcode_models_table_real_listing() {
        // Captured verbatim from `commandcode --list-models` (authenticated).
        let out = "Available models  ·  67 models\n\
                   \n\
                   Open Source\n\
                   \n\
                   deepseek/deepseek-v4-pro               hybrid-attention long-context reasoning\n\
                   deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)\n\
                   moonshotai/kimi-k3                     long-horizon coding & knowledge work with 1M context\n";
        let cfg = commandcode_config_from(out);
        assert_eq!(cfg.models.len(), 3);
        assert_eq!(cfg.models[0].id, "deepseek/deepseek-v4-pro");
        assert_eq!(cfg.models[0].label, "hybrid-attention long-context reasoning");
        assert_eq!(cfg.default_model.as_deref(), Some("deepseek/deepseek-v4-flash"));
        assert_eq!(cfg.models[1].label, "fast hybrid-attention reasoning");
    }

    #[test]
    fn parse_commandcode_models_table_headers_never_parse() {
        let out = "Available models  ·  67 models\nOpen Source\nFlagship\n";
        let cfg = commandcode_config_from(out);
        assert!(cfg.models.is_empty());
        assert!(cfg.default_model.is_none());
    }

    // ---- resolve_opencode_model_in (bare id → "provider/id") ----

    fn oc_cfg(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn opencode_bare_id_resolves_via_config() {
        // Shape mirrors a real opencode.json (sharkai + forangeai providers).
        let cfg = oc_cfg(
            r#"{"model":"sharkai/glm-5.2","provider":{
                "sharkai":{"models":{"glm-5.2":{"name":"GLM 5.2"},"deepseek-v4-flash":{}}},
                "forangeai":{"models":{"glm-5.3-flash":{}}}}}"#,
        );
        assert_eq!(
            resolve_opencode_model_in(&cfg, "glm-5.3-flash").as_deref(),
            Some("forangeai/glm-5.3-flash")
        );
    }

    #[test]
    fn opencode_ambiguous_bare_id_prefers_default_provider() {
        // "glm-5.2" exists under both providers; the config default's
        // provider (sharkai) wins over alphabetical order (forangeai).
        let cfg = oc_cfg(
            r#"{"model":"sharkai/glm-5.2","provider":{
                "forangeai":{"models":{"glm-5.2":{}}},
                "sharkai":{"models":{"glm-5.2":{}}}}}"#,
        );
        assert_eq!(
            resolve_opencode_model_in(&cfg, "glm-5.2").as_deref(),
            Some("sharkai/glm-5.2")
        );
    }

    #[test]
    fn opencode_unknown_bare_id_stays_unresolved() {
        let cfg = oc_cfg(
            r#"{"model":"sharkai/glm-5.2","provider":{
                "sharkai":{"models":{"glm-5.2":{}}}}}"#,
        );
        // Static-catalog leftovers ("claude-opus-4-8", …) match nothing —
        // the caller falls back to the pass-through default.
        assert_eq!(resolve_opencode_model_in(&cfg, "claude-opus-4-8"), None);
        // No provider section at all.
        assert_eq!(resolve_opencode_model_in(&oc_cfg("{}"), "glm-5.2"), None);
    }

    // ---- Grandchild-pipe hang regression tests (audit #82) ----

    #[test]
    #[cfg(windows)]
    fn capture_cli_stdout_recovers_when_grandchild_holds_the_pipe() {
        // cmd.exe exits immediately after `echo`, but the `start /b ping`
        // grandchild inherits the stdout pipe and runs for 30s. The old
        // kill-only-the-direct-child + unconditional drain.join() blocked
        // for the full 30s (forever for a hung CLI); the tree-kill + bounded
        // join must return the output in a few seconds.
        let start = std::time::Instant::now();
        let out = capture_cli_stdout(
            "cmd",
            &["/C", "start /b ping -n 30 127.0.0.1 & echo model-list"],
            20,
        );
        let elapsed = start.elapsed();
        assert!(
            out.as_deref().unwrap_or("").contains("model-list"),
            "output must survive the tree-kill: {out:?}"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(15),
            "must not wait out the grandchild's runtime, took {elapsed:?}"
        );
    }

    #[test]
    fn capture_cli_stdout_timeout_path_returns_without_hanging() {
        // A child that outlives the tick budget (30s runtime vs 0.5s budget)
        // must come back as None promptly — the drain must never wedge the
        // model-listing command.
        let start = std::time::Instant::now();
        let out = if cfg!(windows) {
            capture_cli_stdout("ping", &["-n", "30", "127.0.0.1"], 5)
        } else {
            capture_cli_stdout("sleep", &["30"], 5)
        };
        assert_eq!(out, None, "an over-budget child yields no models");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(15),
            "timeout path must return promptly, took {:?}",
            start.elapsed()
        );
    }
}
