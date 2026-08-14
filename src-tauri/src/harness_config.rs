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

#[derive(Serialize)]
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
    use std::process::{Command, Stdio};
    use std::time::Duration;

    let spec = crate::harness_adapters::resolve_for_spawn(
        &crate::harness_adapters::CommandSpec::new("opencode", &["models"]),
    );
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
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    // Drain stdout on a background thread BEFORE waiting. Reading only after
    // exit deadlocks once the model registry exceeds the OS pipe buffer
    // (~64KB): the child blocks on a full pipe and never exits, so the wait
    // loop times out and the whole list is dropped. Same pattern as git.rs's
    // run_git drain threads.
    use std::io::Read;
    let mut stdout_pipe = child
        .stdout
        .take()
        .expect("piped stdout is present right after spawn");
    let drain = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout_pipe.read_to_string(&mut out);
        out
    });
    // 8s is generous for a local registry dump; a hung shim must not wedge
    // the model dropdown.
    for _ in 0..80 {
        match child.try_wait() {
            Ok(Some(_)) => {
                let out = drain.join().unwrap_or_default();
                return out
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| l.contains('/') && !l.contains(' '))
                    .collect();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return vec![];
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    let _ = drain.join();
    vec![]
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
}
