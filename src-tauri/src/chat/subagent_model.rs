//! Subagent-model orchestration (`chat.subagentModel`).
//!
//! Lets spawned work run on a model that differs from the parent session's:
//! a session-wide default picked in Settings (persisted as
//! `chat.subagentModel`), plus a per-call `model` argument on the `task` and
//! `spawn_session` tools so the model itself can route mechanical sub-work to
//! a cheaper one. Two consumers:
//! - `dispatch::run_task_subagent` — the built-in Task subagent (provider may
//!   switch; that loop does its own provider HTTP);
//! - `session_fabric::mesh_spawn_session` — mesh children of any engine.
//!
//! Pick syntax mirrors the memory extract-model override (`memory.extractModel`):
//! a bare model id keeps the parent's provider, `provider::model` targets
//! another one. A cross-provider pick is only honored for built-in-family
//! children with a saved API key for that provider — harness CLIs own their
//! auth, so for them the provider half is ignored.

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

/// Settings key holding the session-wide subagent model pick.
pub const SETTING_SUBAGENT_MODEL: &str = "chat.subagentModel";

/// CLI engine ids a pick may name (`claude_code::sonnet` runs spawned
/// sessions on the Claude Code harness with model `sonnet`). Mirrors the
/// harness half of `automation_cmds::ALLOWED_AGENTS`; anything outside this
/// list (and not an `acp:` id) is treated as a cloud/local PROVIDER id.
pub const HARNESS_ENGINE_IDS: [&str; 5] = ["claude_code", "opencode", "pi", "omp", "commandcode"];

/// A parsed subagent-model pick: `provider::model` or a bare model id.
/// The provider half is either an API provider id (anthropic, openai, …),
/// `local_gguf`, or a CLI engine id from [`HARNESS_ENGINE_IDS`].
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentModelPick {
    /// `Some` only for the `provider::model` form — a bare id keeps the
    /// caller's provider.
    pub provider: Option<String>,
    pub model: String,
}

impl SubagentModelPick {
    pub fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        match raw.split_once("::") {
            Some((p, m)) if !p.is_empty() && !m.is_empty() => Some(Self {
                provider: Some(p.to_string()),
                model: m.to_string(),
            }),
            _ => Some(Self {
                provider: None,
                model: raw.to_string(),
            }),
        }
    }

    pub fn parse_arg(args: &serde_json::Value) -> Option<Self> {
        args.get("model")
            .and_then(|v| v.as_str())
            .and_then(Self::parse)
    }
}

/// The Settings pick, if set and well-formed.
pub fn setting_pick(conn: &Connection) -> Option<SubagentModelPick> {
    crate::db::get_setting(conn, SETTING_SUBAGENT_MODEL)
        .ok()
        .flatten()
        .and_then(|v| SubagentModelPick::parse(&v))
}

/// The CLI/ACP engine a pick names, when it names one (`claude_code` →
/// `harness:claude_code`, `acp:zed` as-is). Cloud/local provider picks and
/// bare ids return None — they only change the model, not the engine.
pub fn pick_engine(pick: &SubagentModelPick) -> Option<String> {
    let p = pick.provider.as_deref()?;
    if let Some(rest) = p.strip_prefix("acp:") {
        if !rest.is_empty() {
            return Some(p.to_string());
        }
        return None;
    }
    if HARNESS_ENGINE_IDS.contains(&p) {
        return Some(format!("harness:{p}"));
    }
    None
}

/// Explicit tool-call pick, falling back to the Settings default.
pub fn pick_for_call(conn: &Connection, args: &serde_json::Value) -> Option<SubagentModelPick> {
    SubagentModelPick::parse_arg(args).or_else(|| setting_pick(conn))
}

/// Apply a pick to the built-in Task subagent's resolution. A same-provider
/// pick swaps the model only; a cross-provider one brings that provider's own
/// key + base URL (mirrors the memory extract-model override) and degrades
/// back to the session resolution — logged, never fatal — when the provider
/// has no saved key or is a local sidecar not currently serving the model.
/// Engine-named picks (claude_code::sonnet) don't apply here: the Task
/// subagent is an in-process API loop, CLI engines delegate via
/// `spawn_session` — logged and skipped. Returns
/// `(provider, model, api_key, base_url)`.
pub fn apply_task_pick(
    app: &AppHandle,
    provider: String,
    model: String,
    api_key: String,
    base_url: Option<String>,
    pick: Option<SubagentModelPick>,
) -> (String, String, String, Option<String>) {
    let Some(pick) = pick else {
        return (provider, model, api_key, base_url);
    };
    if pick.provider.as_deref().map_or(true, |p| p == provider) {
        return (provider, pick.model, api_key, base_url);
    }
    if pick_engine(&pick).is_some() {
        eprintln!(
            "[subagent-model] {}::{} ignored — Task subagents run on API providers; \
             spawn_session delegates to CLI engines",
            pick.provider.as_deref().unwrap_or_default(),
            pick.model
        );
        return (provider, model, api_key, base_url);
    }
    let override_provider = pick.provider.unwrap_or_default();
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    if override_provider == "local_gguf" {
        if let Some(state) = app.try_state::<crate::chat::local_models::LocalModelState>() {
            if let Some(active) = state.0.status() {
                if active.model_id == pick.model {
                    return (
                        override_provider,
                        pick.model,
                        String::new(),
                        Some(active.base_url),
                    );
                }
            }
        }
        eprintln!(
            "[subagent-model] {override_provider}::{} ignored — sidecar not running it",
            pick.model
        );
        return (provider, model, api_key, base_url);
    }
    let (override_key, override_base) = (
        crate::secrets::get_chat_api_key(&conn, &override_provider).unwrap_or_default(),
        crate::db::get_setting(&conn, &format!("chat.{override_provider}.base_url"))
            .unwrap_or(None),
    );
    if override_key.trim().is_empty() {
        eprintln!(
            "[subagent-model] {override_provider}::{} ignored — no API key saved for {override_provider}",
            pick.model
        );
        return (provider, model, api_key, base_url);
    }
    (override_provider, pick.model, override_key, override_base)
}

/// Resolve the model (and, for built-in children, the provider) a mesh child
/// session runs on: the explicit/Settings pick when honor-able, else the
/// parent's inheritance. `child_is_cli` says the child runs a harness/ACP
/// engine. Engine-named picks (`claude_code::sonnet`) reach here only when
/// the child RUNS that engine (the caller resolves the engine and drops
/// conflicting picks) — the model transfers, the row keeps the parent's
/// provider. Cross-provider cloud picks need a saved key for that provider
/// and never re-model a CLI child (the CLI owns its auth).
pub fn resolve_spawn_model(
    conn: &Connection,
    parent_provider: &str,
    parent_model: &str,
    child_is_cli: bool,
    pick: Option<SubagentModelPick>,
) -> (String, String) {
    let inherited = if parent_model.trim().is_empty() {
        "auto".to_string()
    } else {
        parent_model.to_string()
    };
    let Some(pick) = pick else {
        return (parent_provider.to_string(), inherited);
    };
    let Some(pick_provider) = pick.provider.as_deref() else {
        // Bare id: keeps the parent's provider (harness children read it as
        // their own --model value).
        return (parent_provider.to_string(), pick.model);
    };
    if pick_provider == parent_provider {
        return (parent_provider.to_string(), pick.model);
    }
    if pick_engine(&pick).is_some() {
        // Engine-matched pick (caller-filtered): move the model onto the CLI.
        return (parent_provider.to_string(), pick.model);
    }
    if child_is_cli {
        return (parent_provider.to_string(), inherited);
    }
    // Local sidecar picks need no key — the send path resolves the sidecar's
    // base URL for the local_gguf provider (the caller drops the pick when
    // the sidecar isn't serving the model, so a spawn never silently
    // degrades here).
    if pick_provider == "local_gguf" {
        return ("local_gguf".to_string(), pick.model);
    }
    let key = crate::secrets::get_chat_api_key(conn, pick_provider).unwrap_or_default();
    if key.trim().is_empty() {
        eprintln!(
            "[subagent-model] {pick_provider}::{} ignored — no API key saved for {pick_provider}",
            pick.model
        );
        return (parent_provider.to_string(), inherited);
    }
    (pick_provider.to_string(), pick.model)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(provider: Option<&str>, model: &str) -> Option<SubagentModelPick> {
        Some(SubagentModelPick {
            provider: provider.map(str::to_string),
            model: model.to_string(),
        })
    }

    #[test]
    fn parse_handles_both_forms() {
        assert_eq!(
            SubagentModelPick::parse("openai::gpt-4o-mini"),
            Some(SubagentModelPick {
                provider: Some("openai".into()),
                model: "gpt-4o-mini".into()
            })
        );
        assert_eq!(
            SubagentModelPick::parse(" claude-sonnet-4-5 "),
            Some(SubagentModelPick {
                provider: None,
                model: "claude-sonnet-4-5".into()
            })
        );
        assert_eq!(SubagentModelPick::parse(""), None);
        assert_eq!(SubagentModelPick::parse("  "), None);
        // Degenerate halves fall back to a bare id rather than dropping the pick.
        assert_eq!(
            SubagentModelPick::parse("openai::"),
            Some(SubagentModelPick {
                provider: None,
                model: "openai::".into()
            })
        );
    }

    #[test]
    fn parse_arg_reads_model_field() {
        let args = serde_json::json!({ "model": "anthropic::claude-haiku-4-5" });
        assert_eq!(
            SubagentModelPick::parse_arg(&args),
            Some(SubagentModelPick {
                provider: Some("anthropic".into()),
                model: "claude-haiku-4-5".into()
            })
        );
        assert_eq!(SubagentModelPick::parse_arg(&serde_json::json!({})), None);
    }

    #[test]
    fn pick_engine_distinguishes_engines_from_providers() {
        let harness = SubagentModelPick::parse("claude_code::sonnet").unwrap();
        assert_eq!(pick_engine(&harness).as_deref(), Some("harness:claude_code"));
        let acp = SubagentModelPick::parse("acp:zed::fast").unwrap();
        assert_eq!(pick_engine(&acp).as_deref(), Some("acp:zed"));
        let cloud = SubagentModelPick::parse("openai::gpt-4o-mini").unwrap();
        assert_eq!(pick_engine(&cloud), None);
        let local = SubagentModelPick::parse("local_gguf::qwen").unwrap();
        assert_eq!(pick_engine(&local), None);
        let bare = SubagentModelPick::parse("sonnet").unwrap();
        assert_eq!(pick_engine(&bare), None);
        // Unknown ids stay provider picks (key-checked) — never engines.
        let typo = SubagentModelPick::parse("cluade_code::sonnet").unwrap();
        assert_eq!(pick_engine(&typo), None);
    }

    #[test]
    fn resolve_spawn_model_inherits_without_pick() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(
            resolve_spawn_model(&conn, "anthropic", "claude-sonnet-4-5", false, None),
            ("anthropic".to_string(), "claude-sonnet-4-5".to_string())
        );
        assert_eq!(
            resolve_spawn_model(&conn, "anthropic", "", true, None),
            ("anthropic".to_string(), "auto".to_string())
        );
    }

    #[test]
    fn resolve_spawn_model_bare_and_engine_and_cli() {
        let conn = Connection::open_in_memory().unwrap();
        // Bare id keeps the parent provider on every child kind.
        assert_eq!(
            resolve_spawn_model(&conn, "openai", "gpt-5", false, pick(None, "gpt-4o-mini")),
            ("openai".to_string(), "gpt-4o-mini".to_string())
        );
        // Engine pick onto a matching CLI child: model transfers, provider row
        // stays the parent's (the CLI owns auth).
        assert_eq!(
            resolve_spawn_model(
                &conn,
                "anthropic",
                "claude-opus-4-1",
                true,
                pick(Some("claude_code"), "sonnet")
            ),
            ("anthropic".to_string(), "sonnet".to_string())
        );
        // A cloud pick never re-models a CLI child.
        assert_eq!(
            resolve_spawn_model(
                &conn,
                "anthropic",
                "claude-opus-4-1",
                true,
                pick(Some("openai"), "gpt-4o-mini")
            ),
            ("anthropic".to_string(), "claude-opus-4-1".to_string())
        );
        // Local sidecar picks need no API key — the send path resolves the
        // sidecar base URL for the local_gguf provider.
        assert_eq!(
            resolve_spawn_model(
                &conn,
                "openai",
                "gpt-5",
                false,
                pick(Some("local_gguf"), "qwen3-8b")
            ),
            ("local_gguf".to_string(), "qwen3-8b".to_string())
        );
    }
}
