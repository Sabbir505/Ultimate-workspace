//! Composer predictions (`composer.predictions` + `composer.predictionsModel`).
//!
//! After an assistant reply lands in the session the user is viewing, the
//! renderer asks for a suggestion of the user's NEXT message; it renders as
//! ghost text in an empty composer and Tab accepts it (fills the box, never
//! sends). Mirrors OpenAI's "Composer predictions in Codex" shape.
//!
//! Model resolution follows the established auxiliary-call conventions:
//! - default: the session row's provider/model (auto sessions resolve through
//!   the auto router, like `/create` does);
//! - override: `composer.predictionsModel` in the `provider::model` syntax of
//!   `chat.subagentModel` (`claude_code::sonnet`, `openai::gpt-4o-mini`,
//!   `local_gguf::<name>`), where the provider half may name any family —
//!   harness CLI, API provider, or the local sidecar.
//!
//! Dispatch by family mirrors `artifacts/generator.rs`: API + local go through
//! `llm_client::oneshot` (HTTP), harness engines through
//! `harness_oneshot_text` (CLI spawn). ACP agents have no one-shot path and
//! are skipped. Every failure is silent — a prediction is a bonus, never an
//! error the user sees. Suggestions are ephemeral: nothing is persisted.

use std::collections::HashSet;
use std::sync::OnceLock;

use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

use crate::db;

use super::commands::{resolve_auto_session_pick, strip_think_blocks};
use super::subagent_model::{SubagentModelPick, HARNESS_ENGINE_IDS};

/// Feature gate. Default ON — only the literal `"false"` disables (same
/// convention as `checkpoints.enabled`).
pub const SETTING_COMPOSER_PREDICTIONS: &str = "composer.predictions";
/// Model override: `""` = follow the active chat's model, else
/// `provider::model` (see [`SubagentModelPick`]).
pub const SETTING_COMPOSER_PREDICTIONS_MODEL: &str = "composer.predictionsModel";

/// Longest suggestion we surface. The prompt asks for one short message; a
/// model that rambles gets capped rather than shown raw.
const SUGGESTION_MAX_CHARS: usize = 400;
/// Tail of the conversation fed to the predictor.
const TRANSCRIPT_MAX_MESSAGES: usize = 8;
const TRANSCRIPT_MAX_CHARS: usize = 6000;
const MESSAGE_MAX_CHARS: usize = 600;
/// Output cap for the HTTP families (the CLI families carry their own).
const MAX_TOKENS: u32 = 96;

/// Harness adapters this module accepts by id. `HARNESS_ENGINE_IDS` omits
/// `kimi_code` (a registered per-turn adapter), but a kimi session's row says
/// `harness:kimi_code` and must predict like any other.
const EXTRA_HARNESS_IDS: [&str; 1] = ["kimi_code"];

/// One prediction in flight per session — a double-triggered `onDone` must
/// not spend tokens twice.
fn in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

struct InFlightGuard(String);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        in_flight().lock().remove(&self.0);
    }
}

/// Generate a suggestion for `chat_session_id`, or `None` when the feature is
/// off, no family can serve the call, or generation fails. Never errors.
pub(crate) async fn generate(
    app: &AppHandle,
    db: &crate::DbState,
    chat_session_id: &str,
) -> Option<String> {
    {
        let conn = db.0.lock();
        if db::get_setting(&conn, SETTING_COMPOSER_PREDICTIONS)
            .ok()
            .flatten()
            .as_deref()
            == Some("false")
        {
            return None;
        }
    }
    if !in_flight().lock().insert(chat_session_id.to_string()) {
        return None;
    }
    let _guard = InFlightGuard(chat_session_id.to_string());

    let raw = generate_raw(app, db, chat_session_id).await?;
    sanitize_suggestion(&raw)
}

/// Which family serves the prediction.
enum Family {
    Http(String),
    Harness(String),
    Local,
    Unsupported,
}

/// The provider string that represents the session's OWN execution path:
/// CLI sessions keep their engine in the `agent` column (the provider/model
/// columns hold a stale cloud provider and a CLI alias like "sonnet" — see
/// `artifacts/context.rs::get_llm_context`), everything else uses the
/// provider column. `None` = ACP, which has no one-shot path.
fn session_provider(session: &crate::types::ChatSession) -> Option<String> {
    match session.agent.as_deref() {
        Some(agent) if agent.starts_with("harness:") => Some(agent.to_string()),
        Some(agent) if agent.starts_with("acp:") => None,
        _ => Some(session.provider.clone()),
    }
}

fn family_of(provider: &str) -> Family {
    if let Some(id) = provider.strip_prefix("harness:") {
        // A bare `harness:` names no engine — nothing to spawn.
        return if id.is_empty() {
            Family::Unsupported
        } else {
            Family::Harness(id.to_string())
        };
    }
    if provider.starts_with("acp:") {
        // No one-shot path exists for ACP agents.
        return Family::Unsupported;
    }
    // `provider_kind` (not an exact match): a suffixed local endpoint id
    // ("local_gguf-2") is still the sidecar family, and must not fall through
    // to the HTTP branch where the keyless lookup would silently skip it.
    if crate::chat::providers::provider_kind(provider) == "local_gguf" {
        return Family::Local;
    }
    if HARNESS_ENGINE_IDS.contains(&provider) || EXTRA_HARNESS_IDS.contains(&provider) {
        return Family::Harness(provider.to_string());
    }
    Family::Http(provider.to_string())
}

async fn generate_raw(
    app: &AppHandle,
    db: &crate::DbState,
    chat_session_id: &str,
) -> Option<String> {
    let session = {
        let conn = db.0.lock();
        db::get_chat_session(&conn, chat_session_id).ok().flatten()?
    };

    let transcript = {
        let conn = db.0.lock();
        let rows = db::list_active_chat_messages(&conn, chat_session_id).ok()?;
        let pairs: Vec<(&str, &str)> = rows
            .iter()
            .map(|r| (r.role.as_str(), r.content.as_str()))
            .collect();
        format_transcript(&pairs)
    }?;

    let pick = {
        let conn = db.0.lock();
        db::get_setting(&conn, SETTING_COMPOSER_PREDICTIONS_MODEL)
            .ok()
            .flatten()
            .filter(|v| !v.trim().is_empty())
            .and_then(|v| SubagentModelPick::parse(&v))
    };
    let (provider, model) = match &pick {
        Some(p) => (
            match &p.provider {
                Some(provider) => provider.clone(),
                // A bare model id keeps the chat's own path — for a CLI
                // session that IS the engine, not the stale provider column.
                None => session_provider(&session)?,
            },
            p.model.clone(),
        ),
        None => (session_provider(&session)?, session.model.clone()),
    };

    // Auto rows hold either `auto` (fresh chat) or the last resolution; both
    // re-resolve through the router so a fresh Auto chat doesn't read
    // "auto" as an OpenAI-shaped endpoint (the /create bug). CLI sessions are
    // never auto candidates, so the flag never re-routes them.
    let auto = provider == "auto"
        || (pick.is_none()
            && session.auto_model
            && !provider.starts_with("harness:")
            && !provider.starts_with("acp:"));
    let (provider, model) = if auto {
        resolve_auto_session_pick(db, &provider, &model, 0, false).await.ok()?
    } else {
        (provider, model)
    };

    let system = "You predict what the user will say next in this conversation. \
        Reply with ONLY the user's next message — one short, specific follow-up \
        or instruction they would plausibly send right now. Match the \
        conversation's language and tone. No quotes, no markdown, no role \
        prefix, no explanation.";
    let user = format!("Conversation so far:\n{transcript}\n\nUser's next message:");

    let text = match family_of(&provider) {
        Family::Unsupported => None,
        Family::Harness(harness_id) => {
            let prompt = format!("{system}\n\n{user}");
            let cwd = session
                .cwd_override
                .clone()
                .filter(|c| !c.trim().is_empty())
                .or_else(|| session.worktree_path.clone().filter(|c| !c.trim().is_empty()));
            crate::agent_sessions::harness_oneshot_text(
                &harness_id,
                &model,
                &prompt,
                cwd.as_deref(),
            )
            .await
            .ok()
        }
        Family::Local => {
            // llama-server must be running: a stopped sidecar's persisted
            // base URL is a port from a previous run, not a server.
            let live = app
                .try_state::<crate::chat::local_models::LocalModelState>()
                .and_then(|s| s.0.status())?;
            // Canonical provider id: `resolve_request_model` swaps the stored
            // display name for the wire model id only for exact "local_gguf".
            let provider = "local_gguf";
            let (wire_model, base) = {
                let conn = db.0.lock();
                (
                    crate::chat::local_models::resolve_request_model(
                        &conn,
                        provider,
                        Some(model.clone()),
                        Some(&live),
                    ),
                    crate::chat::local_models::local_base_url(&conn, Some(&live)),
                )
            };
            let (Some(wire_model), Some(base)) = (wire_model, base) else {
                return None;
            };
            let client = super::llm_client::oneshot_client().ok()?;
            // Keyless: llama-server ignores the auth header.
            super::llm_client::oneshot(
                provider,
                &client,
                "",
                Some(&base),
                &wire_model,
                system,
                &user,
                MAX_TOKENS,
                Some(MAX_TOKENS),
            )
            .await
            .ok()
            .flatten()
        }
        Family::Http(provider) => {
            let (api_key, base, setting_model) = {
                let conn = db.0.lock();
                (
                    crate::secrets::get_chat_api_key(&conn, &provider).unwrap_or_default(),
                    db::get_setting(&conn, &format!("chat.{provider}.base_url"))
                        .ok()
                        .flatten()
                        .filter(|b| !b.trim().is_empty()),
                    db::get_setting(&conn, &format!("chat.{provider}.model"))
                        .ok()
                        .flatten()
                        .filter(|m| !m.trim().is_empty()),
                )
            };
            if api_key.trim().is_empty() {
                // local_gguf is the only keyless HTTP family and is handled
                // above; a keyless cloud provider has no reachable endpoint.
                return None;
            }
            let model = if model.trim().is_empty() {
                setting_model?
            } else {
                model
            };
            let client = super::llm_client::oneshot_client().ok()?;
            super::llm_client::oneshot(
                &provider,
                &client,
                &api_key,
                base.as_deref(),
                &model,
                system,
                &user,
                MAX_TOKENS,
                Some(MAX_TOKENS),
            )
            .await
            .ok()
            .flatten()
        }
    }?;

    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// Format the last few user/assistant messages as a labeled transcript.
/// Requires at least one assistant reply in the window — a lone user message
/// has nothing to predict from. Pure so it is unit-testable without a DB.
fn format_transcript(rows: &[(&str, &str)]) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut has_assistant = false;
    let mut total = 0usize;
    for (role, content) in rows.iter().rev() {
        if lines.len() >= TRANSCRIPT_MAX_MESSAGES {
            break;
        }
        let who = match *role {
            "user" => "User",
            "assistant" => "Assistant",
            _ => continue,
        };
        let text = strip_think_blocks(content);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if who == "Assistant" {
            has_assistant = true;
        }
        let snippet: String = text.chars().take(MESSAGE_MAX_CHARS).collect();
        total += snippet.chars().count() + 8;
        if total > TRANSCRIPT_MAX_CHARS {
            break;
        }
        lines.push(format!("{who}: {snippet}"));
    }
    if !has_assistant || lines.is_empty() {
        return None;
    }
    lines.reverse();
    Some(lines.join("\n"))
}

/// Tidy a model reply into a one-line suggestion: strip reasoning blocks,
/// unwrap a code fence, keep the first paragraph, drop surrounding quotes and
/// a leading label, collapse whitespace, and cap the length.
pub(crate) fn sanitize_suggestion(raw: &str) -> Option<String> {
    let stripped = strip_think_blocks(raw);
    let mut t = stripped.trim();
    if t.starts_with("```") {
        if let Some(nl) = t.find('\n') {
            let inner = &t[nl + 1..];
            t = match inner.rfind("```") {
                Some(end) => inner[..end].trim(),
                None => inner.trim(),
            };
        }
    }
    t = t.split("\n\n").next().unwrap_or("").trim();
    // Drop surrounding quotes and a leading label the model sometimes adds —
    // in either order ("Next message: \"…\"" and "\"Next message: …\"" both
    // occur), so loop until stable (two passes cover every observed shape).
    const LABEL_PREFIXES: [&str; 6] = [
        "Next message:",
        "User's next message:",
        "User:",
        "Suggestion:",
        "Message:",
        "Next:",
    ];
    for _ in 0..2 {
        let before = t;
        t = t
            .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '“' | '”' | '‘' | '’'))
            .trim();
        for prefix in LABEL_PREFIXES {
            if let Some(rest) = t.strip_prefix(prefix) {
                t = rest.trim();
                break;
            }
        }
        if t == before {
            break;
        }
    }
    let one_line = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.is_empty() {
        return None;
    }
    let capped: String = one_line.chars().take(SUGGESTION_MAX_CHARS).collect();
    let capped = capped.trim_end().to_string();
    if capped.is_empty() {
        None
    } else {
        Some(capped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_quotes_and_labels() {
        assert_eq!(
            sanitize_suggestion("\"Run the tests again\"").as_deref(),
            Some("Run the tests again")
        );
        assert_eq!(
            sanitize_suggestion("Next message: Commit this with a clear message").as_deref(),
            Some("Commit this with a clear message")
        );
        assert_eq!(
            sanitize_suggestion("User's next message: “Use the second approach”").as_deref(),
            Some("Use the second approach")
        );
    }

    #[test]
    fn sanitize_unwraps_fences_and_takes_the_first_paragraph() {
        assert_eq!(
            sanitize_suggestion("```\nRefactor the auth middleware\n```").as_deref(),
            Some("Refactor the auth middleware")
        );
        assert_eq!(
            sanitize_suggestion("Continue with the plan.\n\nExtra commentary follows.").as_deref(),
            Some("Continue with the plan.")
        );
    }

    #[test]
    fn sanitize_collapses_to_one_line_and_caps() {
        assert_eq!(
            sanitize_suggestion("  run\n  the   tests \t").as_deref(),
            Some("run the tests")
        );
        // A single overlong token makes the cap boundary exact (a spaced
        // string would end on a trimmed space just under the limit).
        let long = "x".repeat(450);
        let out = sanitize_suggestion(&long).unwrap();
        assert_eq!(out.chars().count(), SUGGESTION_MAX_CHARS);
        assert_eq!(sanitize_suggestion("   "), None);
        assert_eq!(sanitize_suggestion("```\n\n```"), None);
    }

    #[test]
    fn sanitize_strips_think_blocks() {
        assert_eq!(
            sanitize_suggestion("<think>weighing options</think>Ship it").as_deref(),
            Some("Ship it")
        );
    }

    #[test]
    fn transcript_requires_an_assistant_reply_and_keeps_chronology() {
        assert_eq!(format_transcript(&[("user", "hello")]), None);
        assert_eq!(format_transcript(&[]), None);
        let rows = [
            ("user", "add auth"),
            ("assistant", "done — middleware added"),
            ("user", "now add tests"),
            ("assistant", "tests added"),
            ("tool", "ignored row"),
        ];
        assert_eq!(
            format_transcript(&rows).as_deref(),
            Some(
                "User: add auth\nAssistant: done — middleware added\n\
                 User: now add tests\nAssistant: tests added"
            )
        );
    }

    #[test]
    fn transcript_keeps_the_tail_and_caps_message_length() {
        let mut rows: Vec<(String, String)> = Vec::new();
        for i in 0..12 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            rows.push((role.to_string(), format!("message {i}")));
        }
        rows.push(("user".into(), "q".repeat(1000)));
        rows.push(("assistant".into(), "a".repeat(1000)));
        let pairs: Vec<(&str, &str)> = rows.iter().map(|(r, c)| (r.as_str(), c.as_str())).collect();
        let out = format_transcript(&pairs).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), TRANSCRIPT_MAX_MESSAGES);
        // The last two rows survive; each snippet is capped at 600 chars.
        assert!(lines[lines.len() - 1].starts_with("Assistant: a"));
        assert!(lines[lines.len() - 1].len() <= "Assistant: ".len() + MESSAGE_MAX_CHARS);
    }

    #[test]
    fn session_provider_reads_the_agent_column_for_cli_sessions() {
        let session = |agent: Option<&str>, provider: &str| {
            let mut v = serde_json::json!({
                "id": "s",
                "provider": provider,
                "model": "sonnet",
                "createdAt": 0,
                "lastActiveAt": 0,
            });
            if let Some(a) = agent {
                v["agent"] = serde_json::json!(a);
            }
            serde_json::from_value::<crate::types::ChatSession>(v).unwrap()
        };
        // Harness sessions: the agent column wins over the (stale) provider.
        assert_eq!(
            session_provider(&session(Some("harness:claude_code"), "anthropic")).as_deref(),
            Some("harness:claude_code")
        );
        // ACP has no one-shot path — skip.
        assert_eq!(session_provider(&session(Some("acp:zed"), "anthropic")), None);
        // Built-in/local/None agents keep the provider column (even "auto").
        assert_eq!(
            session_provider(&session(Some("builtin"), "auto")).as_deref(),
            Some("auto")
        );
        assert_eq!(
            session_provider(&session(Some("local"), "local_gguf")).as_deref(),
            Some("local_gguf")
        );
        assert_eq!(
            session_provider(&session(None, "openai")).as_deref(),
            Some("openai")
        );
    }

    #[test]
    fn family_of_maps_each_provider_form() {
        assert!(matches!(family_of("harness:claude_code"), Family::Harness(id) if id == "claude_code"));
        assert!(matches!(family_of("claude_code"), Family::Harness(id) if id == "claude_code"));
        assert!(matches!(family_of("kimi_code"), Family::Harness(id) if id == "kimi_code"));
        assert!(matches!(family_of("local_gguf"), Family::Local));
        // Suffixed endpoint ids still classify by kind (provider_kind).
        assert!(matches!(family_of("local_gguf-2"), Family::Local));
        assert!(matches!(family_of("openai"), Family::Http(p) if p == "openai"));
        assert!(matches!(family_of("anthropic-2"), Family::Http(p) if p == "anthropic-2"));
        assert!(matches!(family_of("acp:zed"), Family::Unsupported));
        assert!(matches!(family_of("harness:"), Family::Unsupported));
    }
}
