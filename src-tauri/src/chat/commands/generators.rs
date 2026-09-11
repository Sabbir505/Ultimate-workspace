//! `commands::generators` — carved verbatim from the former commands.rs
//! monolith (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

/// Ask the session's model for a short (3–6 word) title summarizing the
/// conversation so far and persist it. Returns the new title, or `None` when
/// one couldn't be produced (missing key/model, empty transcript, API error) —
/// the caller keeps whatever title already exists.
#[tauri::command]
pub async fn generate_chat_title(
    chat_session_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Option<String>> {
    // mi4: one lock acquisition for the whole read phase — session row, API
    // key, provider settings. Four separate locks serialized against every
    // other DB reader three extra times for no reason (all reads are
    // independent point lookups).
    let (provider_str, model_str, api_key, base_url, model_override) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        let key = secrets::get_chat_api_key(&conn, &cs.provider);
        let base = db::get_setting(&conn, &format!("chat.{}.base_url", cs.provider))
            .map_err(|e| e.to_string())?;
        let mo = db::get_setting(&conn, &format!("chat.{}.model", cs.provider))
            .map_err(|e| e.to_string())?;
        (cs.provider, cs.model, key, base, mo)
    };

    // local_gguf is keyless (runs locally); skip the key check and pass
    // an empty string as the key (the sidecar ignores the auth header).
    if api_key.is_none() && provider_str != "local_gguf" {
        return Ok(None);
    }
    let api_key = api_key.unwrap_or_default();

    let model = if model_str.trim().is_empty() {
        match model_override {
            Some(m) if !m.trim().is_empty() => m,
            _ => return Ok(None),
        }
    } else {
        model_str
    };

    // Build a compact transcript from history (length-capped). Fetch rows
    // under the lock, format AFTER releasing it (strip + truncate are pure
    // CPU work — no reason to hold the DB mutex through them).
    let transcript = {
        let records = {
            let conn = db.0.lock();
            db::list_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string())?
        };
        let mut t = String::new();
        for r in &records {
            let text = strip_think_blocks(&r.content);
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            let who = if r.role == "user" {
                "User"
            } else {
                "Assistant"
            };
            let snippet: String = text.chars().take(600).collect();
            t.push_str(who);
            t.push_str(": ");
            t.push_str(&snippet);
            t.push('\n');
            if t.len() > 4000 {
                break;
            }
        }
        t
    };
    if transcript.trim().is_empty() {
        return Ok(None);
    }

    let system = "You generate a very short chat title (3 to 6 words) summarizing \
        the conversation topic. Reply with ONLY the title text — no surrounding \
        quotes, no trailing punctuation, no 'Title:' prefix.";
    let user = format!("Conversation:\n{transcript}\nTitle:");

    let base_url = base_url.filter(|b| !b.trim().is_empty());
    let client = crate::chat::llm_client::oneshot_client()?;
    let Some(raw) = crate::chat::llm_client::oneshot(
        &provider_str,
        &client,
        &api_key,
        base_url.as_deref(),
        &model,
        system,
        &user,
        32,
    )
    .await?
    else {
        return Ok(None);
    };

    let title = clean_title(&raw);
    if title.is_empty() {
        return Ok(None);
    }
    {
        let conn = db.0.lock();
        db::update_chat_session_title(&conn, &chat_session_id, &title)
            .map_err(|e| e.to_string())?;
    }
    Ok(Some(title))
}

/// Generate a Conventional-Commits-style commit message from the working-tree
/// diff, using the same provider/model/key resolution as `generate_chat_title`.
/// Returns None when there's no diff, no model configured, or generation fails
/// — callers fall back to an empty textarea the user fills in themselves.
#[tauri::command]
pub async fn generate_commit_message(
    path: String,
    chat_session_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Option<String>> {
    // Resolve provider + model. Prefer the dedicated commit-message settings
    // (commitMessage.provider + commitMessage.model) when the user has picked
    // a fast/utility model for this task; fall back to the active chat
    // session's provider/model. The pair is required because API keys and base
    // URLs are stored per-provider — a bare model string can't resolve them.
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let cm_provider = db::get_setting(&conn, "commitMessage.provider")
            .ok()
            .flatten()
            .filter(|p| !p.trim().is_empty());
        let cm_model = db::get_setting(&conn, "commitMessage.model")
            .ok()
            .flatten()
            .filter(|m| !m.trim().is_empty());
        match (cm_provider, cm_model) {
            (Some(p), Some(m)) => (p, m),
            _ => {
                // Fall back to the session's configured provider + model.
                let cs = db::get_chat_session(&conn, &chat_session_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "chat session not found".to_string())?;
                (cs.provider, cs.model)
            }
        }
    };

    let api_key = {
        let conn = db.0.lock();
        secrets::get_chat_api_key(&conn, &provider_str)
    };
    if api_key.is_none() && provider_str != "local_gguf" {
        return Ok(None);
    }
    let api_key = api_key.unwrap_or_default();

    let (base_url, model_override) = {
        let conn = db.0.lock();
        let base = db::get_setting(&conn, &format!("chat.{provider_str}.base_url"))
            .map_err(|e| e.to_string())?;
        let mo = db::get_setting(&conn, &format!("chat.{provider_str}.model"))
            .map_err(|e| e.to_string())?;
        (base, mo)
    };
    let model = if model_str.trim().is_empty() {
        match model_override {
            Some(m) if !m.trim().is_empty() => m,
            _ => return Ok(None),
        }
    } else {
        model_str
    };

    // Fetch the working-tree diff (git diff HEAD, capped at 200KB by
    // get_git_diff). Truncate further to keep the prompt bounded.
    let diff = crate::git::get_git_diff(Path::new(&path))?;
    let diff: String = diff.chars().take(8000).collect();
    if diff.trim().is_empty() {
        return Ok(None);
    }

    let system = "You write a ONE-LINE Conventional Commits commit message from a \
        unified diff. Use imperative mood (e.g. 'add', 'fix', 'refactor'). The \
        message must be a single subject line of at most 80 characters, \
        prefixed with a type like feat:, fix:, refactor:, docs:, chore:, or \
        test:. NO body, NO bullet points, NO blank line — just the subject. \
        Reply with ONLY the subject line — no surrounding quotes, no \
        'Commit message:' prefix, no explanation.";
    let user = format!("Diff:\n{diff}\nCommit subject:");

    let base_url = base_url.filter(|b| !b.trim().is_empty());
    let client = crate::chat::llm_client::oneshot_client()?;
    let Some(raw) = crate::chat::llm_client::oneshot(
        &provider_str,
        &client,
        &api_key,
        base_url.as_deref(),
        &model,
        system,
        &user,
        64,
    )
    .await?
    else {
        return Ok(None);
    };

    // Reasoning models (DeepSeek-R1, Qwen-QwQ, …) wrap chain-of-thought in
    // <think>…</think> before the answer — strip it so only the subject remains.
    let raw = strip_think_blocks(&raw);
    let msg = clean_commit_message(&raw);
    if msg.is_empty() {
        Ok(None)
    } else {
        Ok(Some(msg))
    }
}

/// Tidy a model-generated commit subject: take the first non-empty line,
/// strip stray quotes/labels, and cap at 80 chars (the subject-only budget).
pub(super) fn clean_commit_message(raw: &str) -> String {
    // The prompt asks for one line; take the first non-empty one in case the
    // model added a blank line or trailing commentary.
    let mut t = raw
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string();
    // Strip surrounding quotes the model sometimes adds.
    t = t
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .trim()
        .to_string();
    // Drop a leading "Commit message:" / "Subject:" label if present.
    for prefix in [
        "Commit message:",
        "Commit Message:",
        "Commit subject:",
        "Subject:",
        "Message:",
    ] {
        if let Some(stripped) = t.strip_prefix(prefix) {
            t = stripped.trim().to_string();
            break;
        }
    }
    // Enforce the 80-char subject cap.
    if t.chars().count() > 80 {
        t = t
            .chars()
            .take(80)
            .collect::<String>()
            .trim_end()
            .to_string();
    }
    t.trim().to_string()
}

/// Generate an automated, model-backed review of the working-tree diff
/// (§3.2.8 "Diff review" quick action). Reviews either the whole working
/// tree (`file_path` = None) or a single file (`file_path` = Some(path)).
///
/// Provider/model resolution mirrors `generate_commit_message`: a dedicated
/// `diffReview.provider` + `diffReview.model` pair is preferred, then the
/// active chat session's `(provider, model)`, then — when no chat session is
/// bound (the diff panel isn't tied to one chat) — the first provider with a
/// configured API key. Returns None when there's no diff or generation fails.
#[tauri::command]
pub async fn generate_diff_review(
    path: String,
    chat_session_id: Option<String>,
    file_path: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<Option<String>> {
    // Resolve provider + model. Preference order: dedicated diffReview
    // settings, the bound chat session's provider/model, then the first
    // provider that has a usable API key (the panel isn't tied to a single
    // chat, so "whatever the app has configured" is the sane default).
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let dr_provider = db::get_setting(&conn, "diffReview.provider")
            .ok()
            .flatten()
            .filter(|p| !p.trim().is_empty());
        let dr_model = db::get_setting(&conn, "diffReview.model")
            .ok()
            .flatten()
            .filter(|m| !m.trim().is_empty());
        if let (Some(p), Some(m)) = (dr_provider, dr_model) {
            (p, m)
        } else if let Some(cs) = chat_session_id
            .as_deref()
            .and_then(|sid| db::get_chat_session(&conn, sid).ok().flatten())
        {
            (cs.provider, cs.model)
        } else {
            const PROVIDERS: [&str; 5] = [
                "openai",
                "openrouter",
                "anthropic",
                "openai_compatible",
                "anthropic_compatible",
            ];
            let mut fallback = None;
            for p in PROVIDERS {
                if secrets::get_chat_api_key(&conn, p).is_some() {
                    fallback = Some(p.to_string());
                    break;
                }
            }
            let p = fallback.unwrap_or_else(|| "openai".to_string());
            let m = db::get_setting(&conn, &format!("chat.{p}.model"))
                .ok()
                .flatten()
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "gpt-4o-mini".to_string());
            (p, m)
        }
    };

    let api_key = {
        let conn = db.0.lock();
        secrets::get_chat_api_key(&conn, &provider_str)
    };
    if api_key.is_none() && provider_str != "local_gguf" {
        return Ok(None);
    }
    let api_key = api_key.unwrap_or_default();

    let (base_url, model_override) = {
        let conn = db.0.lock();
        let base = db::get_setting(&conn, &format!("chat.{provider_str}.base_url"))
            .map_err(|e| e.to_string())?;
        let mo = db::get_setting(&conn, &format!("chat.{provider_str}.model"))
            .map_err(|e| e.to_string())?;
        (base, mo)
    };
    let model = if model_str.trim().is_empty() {
        match model_override {
            Some(m) if !m.trim().is_empty() => m,
            _ => return Ok(None),
        }
    } else {
        model_str
    };

    // Fetch the diff: whole working tree, or a single file. Reviews benefit
    // from more context than a one-line commit subject, so the cap is higher —
    // but still bounded so a giant diff can't blow the prompt window.
    let diff = match &file_path {
        Some(fp) => crate::git::get_git_file_diff(Path::new(&path), fp)?,
        None => crate::git::get_git_diff(Path::new(&path))?,
    };
    let diff: String = diff.chars().take(24000).collect();
    if diff.trim().is_empty() {
        return Ok(None);
    }

    let system = concat!(
        "You are a senior engineer doing a focused, high-signal code review. ",
        "Read the unified diff and write a concise review. Structure it with three short sections:\n",
        "## Summary — 2–3 sentences on what the change does and your overall take.\n",
        "## Issues — bullet list of concrete bugs, edge cases, or regressions, each ",
        "pointing at the relevant file/line and a one-line fix. Only list real problems; don't invent nitpicks.\n",
        "## Suggestions — optional: smaller improvements (naming, extraction, tests) worth doing, in a brief bullet list.\n",
        "Use `file +line: message` to reference exact spots. If the diff is ",
        "trivial (typos, docs, formatting), say so plainly instead of padding. ",
        "Keep the whole review under ~60 lines of Markdown. Do not restate the diff back."
    );
    let user = format!("Please review this diff:\n\n{diff}");

    let base_url = base_url.filter(|b| !b.trim().is_empty());
    let client = crate::chat::llm_client::oneshot_client()?;
    let Some(raw) = crate::chat::llm_client::oneshot(
        &provider_str,
        &client,
        &api_key,
        base_url.as_deref(),
        &model,
        system,
        &user,
        2048,
    )
    .await?
    else {
        return Ok(None);
    };

    let review = strip_think_blocks(&raw).trim().to_string();
    if review.is_empty() {
        Ok(None)
    } else {
        Ok(Some(review))
    }
}

