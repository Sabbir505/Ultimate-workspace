//! Reads each CLI harness's OWN configuration to discover the models and
//! endpoints the user actually has set up (mockup 02: the static catalog in
//! `src/lib/harnessModels.ts` can lie when a CLI is pointed at a custom
//! endpoint with custom model ids — which is the norm, not the exception).
//!
//! Config locations (verified on a stock Windows install):
//! - Claude Code: `~/.claude/settings.json` — `model`, plus `env` overrides
//!   (`ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_<ALIAS>_MODEL(_NAME)`) used by
//!   relay setups to remap the built-in aliases to custom upstream models.
//! - Kimi CLI: `~/.kimi-code/config.toml` — `default_model`, `[providers.*]`
//!   with `base_url`, `[models."<id>"]` entries with `display_name`.
//! - OpenCode: `~/.config/opencode/opencode.json` — `model` ("provider/id"),
//!   `provider.<id>.options.baseURL`, `provider.<id>.models` map.
//!
//! Everything is best-effort: a missing/unparseable config just yields an
//! empty result and the frontend falls back to the static catalog.

use serde::Serialize;
use serde_json::Value;

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
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModelConfig {
    /// The CLI's configured default model id, when the config names one.
    pub default_model: Option<String>,
    /// Custom endpoint the CLI is pointed at (ANTHROPIC_BASE_URL / base_url /
    /// baseURL), shown in the dropdown so relay setups are visible.
    pub endpoint: Option<String>,
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
    // The default model always appears in the list, even if the config names
    // one we didn't otherwise discover.
    if let Some(def) = cfg.default_model.clone() {
        if !cfg.models.iter().any(|m| m.id == def) {
            cfg.models.insert(
                0,
                HarnessModelInfo {
                    label: def.clone(),
                    id: def,
                    source: "config",
                },
            );
        }
    }
    cfg
}

impl Default for HarnessModelConfig {
    fn default() -> Self {
        Self {
            default_model: None,
            endpoint: None,
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

    for alias in ["fable", "opus", "sonnet", "haiku"] {
        let up = alias.to_uppercase();
        let mapped = env_s(&format!("ANTHROPIC_DEFAULT_{up}_MODEL"));
        let name = env_s(&format!("ANTHROPIC_DEFAULT_{up}_MODEL_NAME"));
        match (&mapped, &name) {
            (Some(m), Some(n)) => cfg.models.push(HarnessModelInfo {
                id: alias.to_string(),
                label: remap_label(n, m),
                source: "config",
            }),
            (Some(m), None) => cfg.models.push(HarnessModelInfo {
                id: alias.to_string(),
                label: m.clone(),
                source: "config",
            }),
            // No remap: the alias is a CLI built-in pointing at Anthropic's
            // latest of that family.
            _ => cfg.models.push(HarnessModelInfo {
                id: alias.to_string(),
                label: capitalize(alias),
                source: "builtin",
            }),
        }
    }
    cfg
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
            cfg.models.push(HarnessModelInfo {
                id: id.clone(),
                label,
                source: "config",
            });
        }
    }
    cfg
}

// ---------------------------------------------------------------- OpenCode

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
                    cfg.models.push(HarnessModelInfo {
                        id: format!("{pid}/{mid}"),
                        label,
                        source: "config",
                    });
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
            cfg.models.push(HarnessModelInfo {
                label: id.rsplit('/').next().unwrap_or(&id).to_string(),
                id,
                source: "cli",
            });
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
                        cfg.models.push(HarnessModelInfo {
                            id: format!("{pid}/{mid}"),
                            label,
                            source: "config",
                        });
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
                cfg.models.push(HarnessModelInfo {
                    id,
                    label,
                    source: "cli",
                });
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
            cfg.models.push(HarnessModelInfo {
                id: id.to_string(),
                label: id.rsplit('/').next().unwrap_or(id).to_string(),
                source: "cli",
            });
            continue;
        }
        if let Some(base) = label.strip_suffix(" (default)") {
            cfg.default_model = Some(id.to_string());
            cfg.models.push(HarnessModelInfo {
                id: id.to_string(),
                label: base.trim().to_string(),
                source: "cli",
            });
            continue;
        }
        cfg.models.push(HarnessModelInfo {
            id: id.to_string(),
            label: label.to_string(),
            source: "cli",
        });
    }
    cfg
}

/// Parse `omp models --json` into model rows. omp's own provider config is
/// YAML (`~/.omp/agent/models.yml`), which we deliberately don't parse — the
/// live dump already reflects it. Unparseable output yields an empty list
/// rather than garbage rows.
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
            Some(HarnessModelInfo {
                id,
                label,
                source: "cli",
            })
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
    let drain = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout_pipe.read_to_string(&mut out);
        out
    });
    for _ in 0..ticks {
        match child.try_wait() {
            Ok(Some(_)) => return Some(drain.join().unwrap_or_default()),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = drain.join();
                return None;
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    let _ = drain.join();
    None
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
        let out = r#"{"models":[{"provider":"sharkai","id":"glm-5.2","selector":"sharkai/glm-5.2","name":"GLM 5.2","contextWindow":1048576,"maxTokens":131072,"reasoning":true,"thinking":["minimal","low"],"input":["text"],"cost":{"input":0.14,"output":0.28}}"#;
        let out = format!("{out}]}}");
        let rows = parse_omp_models_json(&out);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "sharkai/glm-5.2");
        assert_eq!(rows[0].label, "GLM 5.2");
        assert_eq!(rows[0].source, "cli");
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
}
