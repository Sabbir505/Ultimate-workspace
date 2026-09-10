//! context-primer assembly (history tail/head, summaries) and per-session actual-model persistence — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;
// ---- Context primer (mid-chat engine handoff) ----
//
// A CLI harness keeps its own conversation memory across turns (claude
// `--resume`, kimi `--session`, opencode's server-side session). But a CLI
// that is starting a BRAND-NEW session — the chat's first harness turn, a
// harness switch (the teardown drops the previous engine's resume id, which
// would be meaningless to the new CLI anyway), or an ACP respawn (ACP has no
// resume at all) — knows nothing about what was said before. Without a
// handoff, switching engines mid-chat silently loses the whole conversation;
// the built-in cloud/local providers never had this problem because they
// rebuild history from the DB on every turn.
//
// The primer rebuilds that same DB history as a compact labeled transcript
// and is prepended to the FIRST prompt of the fresh CLI session only (gated
// on `cli_session_id == None`; turns 2+ ride the CLI's own context).
/// Total character budget for the primer transcript (~6k tokens — a compact
/// handoff, not a full replay; very long chats keep their newest turns).

pub(super) const CONTEXT_PRIMER_MAX_CHARS: usize = 32_000;
/// Per-message cap so one giant artifact-dump reply can't eat the budget.
pub(super) const CONTEXT_PRIMER_MESSAGE_CAP: usize = 6_000;
/// When the turns that DON'T fit the tail budget carry at least this many
/// chars, the send command pre-summarizes them with the shared cloud
/// summarizer (see `build_primer_summary`) instead of silently dropping
/// them — long engine-switched chats keep a digest of their older span.
pub(super) const CONTEXT_PRIMER_SUMMARY_TRIGGER_CHARS: usize = 8_000;

/// The identity + artifact-behavior preamble prepended to every harness turn
/// (see the send path's comment for ordering). Extracted from the send path
/// so a test can pin its tool references: the persona must only name tools
/// that actually exist in harness sessions — the relay-tools MCP whitelist
/// (generate_document/plan_document/revise_document/diagram/file, get_skill,
/// list_skills, search_docs) and
/// the relay-browser MCP family. It must NOT reference built-in-chat-only
/// tools like `open_file`, which the CLI cannot call (that phantom reference
/// used to make harness models promise to "open" files and then fail or
/// improvise).
pub(super) fn harness_persona(harness_label: &str) -> String {
    format!(
        "You are Relay — the agent of the Relay desktop workspace, running on \
         the {harness_label} engine. To the user you ARE Relay: if asked who you \
         are, answer \"I'm Relay\" (the {harness_label} engine underneath may be \
         named as a detail), and never deny being Relay.\n\n\
         Files you create or modify are listed in the app's Artifacts gallery \
         after the turn, but do NOT open on screen. When the user should see a \
         finished result (an HTML page, a report, a diagram), name it in your \
         reply with its path so they can open it from the gallery — there is no \
         open-file tool in this session."
    )
}

/// One-shot prompt assembly (automations): `[persona, instructions, custom]`
/// prefix joined with blank lines, then a `---` separator before the prompt —
/// mirroring the chat-session prefix stack's ordering. All prefix parts are
/// optional and skipped when absent/blank; with no prefix at all the prompt
/// rides alone. Pure so tests can pin the ordering.
pub(super) fn assemble_one_shot_prompt(
    persona: Option<&str>,
    instructions: Option<&str>,
    custom: Option<&str>,
    prompt: &str,
) -> String {
    let mut prefix: Vec<&str> = Vec::new();
    if let Some(p) = persona.filter(|p| !p.trim().is_empty()) {
        prefix.push(p);
    }
    if let Some(i) = instructions.filter(|i| !i.trim().is_empty()) {
        prefix.push(i);
    }
    if let Some(c) = custom.filter(|c| !c.trim().is_empty()) {
        prefix.push(c);
    }
    if prefix.is_empty() {
        prompt.to_string()
    } else {
        format!("{}\n\n---\n\n{prompt}", prefix.join("\n\n"))
    }
}

/// DB fetch half of the primer. MUST run before this turn's user message is
/// persisted so the transcript is exactly "the conversation so far" — the new
/// message itself is forwarded verbatim in `content`. `summary` (built async
/// by the send command when the dropped head was large enough) rides on top
/// of the verbatim tail.
pub(super) fn build_context_primer(db: &DbState, chat_session_id: &str, summary: Option<&str>) -> String {
    let records = {
        let conn = db.0.lock();
        // Same rows the built-in providers would re-send (compaction folds and
        // forked-away tails excluded), so the handoff matches what a built-in
        // turn would have seen.
        crate::db::list_active_chat_messages(&conn, chat_session_id).unwrap_or_default()
    };
    context_primer_from_records(&records, summary)
}

/// One rendered primer line (`[Who]: body`) from a record. Display-only
/// `<think>`/`<tool>` markup is stripped (tool JSON the new CLI never ran),
/// per-message capped, and role-labeled.
pub(super) fn primer_line(r: &crate::types::ChatMessageRecord) -> Option<String> {
    let text = crate::chat::commands::strip_think_blocks(&r.content);
    if text.is_empty() {
        return None;
    }
    let who = match r.role.as_str() {
        "user" => "User",
        "assistant" => "Relay",
        _ => "System", // compaction summaries and other meta rows
    };
    let mut body: String = text.chars().take(CONTEXT_PRIMER_MESSAGE_CAP).collect();
    if text.chars().count() > CONTEXT_PRIMER_MESSAGE_CAP {
        body.push_str("…[truncated]");
    }
    Some(format!("[{who}]: {body}"))
}

/// Which records the newest-first tail budget keeps, and what's left over.
/// Returns the tail IN CHRONOLOGICAL ORDER plus (count, chars) of the head —
/// the older turns the tail budget dropped. Drives both the primer rendering
/// and the pre-send head summarization (`build_primer_summary`), so the two
/// always split the history at exactly the same point.
pub(super) fn primer_tail_and_head(
    records: &[crate::types::ChatMessageRecord],
) -> (Vec<&crate::types::ChatMessageRecord>, usize, usize) {
    let mut tail_rev: Vec<&crate::types::ChatMessageRecord> = Vec::new();
    let mut used = 0usize;
    for r in records.iter().rev() {
        let cost = primer_line(r).map(|l| l.len() + 2).unwrap_or(0); // join overhead
        if cost == 0 {
            continue;
        }
        if !tail_rev.is_empty() && used + cost > CONTEXT_PRIMER_MAX_CHARS {
            break;
        }
        used += cost;
        tail_rev.push(r);
    }
    tail_rev.reverse();
    let tail_len = tail_rev.len();
    // Head = everything before the first tail record (records with no
    // rendered line are display-only and belong to neither side).
    let first_tail_id = tail_rev.first().map(|r| r.id);
    let head: Vec<&crate::types::ChatMessageRecord> = records
        .iter()
        .take_while(|r| Some(r.id) != first_tail_id)
        .collect();
    let head_chars: usize = head
        .iter()
        .filter_map(|r| primer_line(r))
        .map(|l| l.len() + 2)
        .sum();
    (tail_rev, head.len(), head_chars)
}

/// Pure transcript builder behind `build_context_primer`.
///
/// Newest-first accumulation within the char budget keeps the most recent
/// turns — the ones the next reply most depends on — when a long chat must be
/// truncated. `summary` (when present) carries a structured summary of the
/// turns that did NOT fit the budget, so a long chat loses nothing: summary
/// for the old span, verbatim transcript for the recent tail. Returns ""
/// when there is nothing to hand over (fresh chat, or history made up
/// entirely of display-only markup).
pub(super) fn context_primer_from_records(
    records: &[crate::types::ChatMessageRecord],
    summary: Option<&str>,
) -> String {
    let (tail, _, _) = primer_tail_and_head(records);
    let lines: Vec<String> = tail.iter().filter_map(|r| primer_line(r)).collect();
    if lines.is_empty() && summary.is_none() {
        return String::new();
    }
    let mut out = String::from(
        "[Context handoff] The earlier part of this conversation ran on a different \
         engine. Continue the conversation naturally — the user's new message follows \
         after the separator.\n\n",
    );
    if let Some(s) = summary {
        out.push_str("[Summary of the earlier turns]\n");
        out.push_str(s);
        out.push_str("\n\n");
    }
    if !lines.is_empty() {
        if summary.is_some() {
            out.push_str("[Recent transcript, verbatim]\n");
        } else {
            out.push_str("The transcript below is everything said so far, oldest first.\n\n");
        }
        out.push_str(&lines.join("\n\n"));
    }
    out
}

/// Summarize the older turns that the primer's char budget would drop, using
/// the shared cloud summarizer (the first configured cloud provider —
/// `resolve_cloud_summarizer`). Called by `send_agent_chat_message` (async)
/// BEFORE the sync spawn path, so the network round-trip never blocks or
/// freezes the spawn flow; `send` just receives the finished summary.
///
/// Returns `None` when: the CLI session already exists (no primer needed),
/// the cloud-summarizer switch is off, the dropped head is under the trigger
/// size, no provider is configured, or the call fails — every case falls
/// back to the truncate-only primer, which is exactly the pre-upgrade
/// behavior.
pub(crate) async fn build_primer_summary(
    db: &DbState,
    chat_session_id: &str,
    harness: &str,
) -> Option<String> {
    // Same gate the send path uses for the primer itself: a CLI session that
    // will be resumed doesn't need a handoff at all.
    let existing_session = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, &cli_session_key(harness, chat_session_id))
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
    };
    if existing_session.is_some() {
        return None;
    }
    // The summarized handoff rides the cloud-compaction switch: one knob
    // governs "may Relay spend cloud tokens on summarization".
    let enabled = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, "chat.cloud.compaction_enabled")
            .ok()
            .flatten()
            .map(|v| !matches!(v.trim(), "false" | "0" | "off"))
            .unwrap_or(true)
    };
    if !enabled {
        return None;
    }

    let records = {
        let conn = db.0.lock();
        crate::db::list_active_chat_messages(&conn, chat_session_id).unwrap_or_default()
    };
    let (_, head_count, head_chars) = primer_tail_and_head(&records);
    if head_count == 0 || head_chars < CONTEXT_PRIMER_SUMMARY_TRIGGER_CHARS {
        return None;
    }

    // Resolve the summarizer: the first configured cloud provider.
    let (provider_id, base, api_key, model) = {
        let conn = db.0.lock();
        crate::chat::commands::resolve_cloud_summarizer(&conn)?
    };

    // Render the head with the same primer lines the tail uses, then let the
    // shared summarizer condense it (per-message trimming included).
    let head_records: Vec<crate::types::ChatMessageRecord> = {
        let (tail, _, _) = primer_tail_and_head(&records);
        let first_tail_id = tail.first().map(|r| r.id);
        records
            .iter()
            .take_while(|r| Some(r.id) != first_tail_id)
            .cloned()
            .collect()
    };
    if head_records.is_empty() {
        return None;
    }
    let mut head_text = String::new();
    for r in &head_records {
        if let Some(line) = primer_line(r) {
            head_text.push_str(&line);
            head_text.push_str("\n\n");
        }
    }
    let head_entry = crate::chat::compaction::CompactionEntry {
        id: 0,
        message: crate::chat::providers::ChatMessage {
            role: "user".to_string(),
            content: head_text,
            images: Vec::new(),
        },
    };
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_default();
    let (summary, _, _) = crate::chat::cloud_compact::summarize_via_provider(
        &client,
        provider_id,
        &base,
        &api_key,
        &model,
        &std::iter::once(&head_entry).collect::<Vec<&crate::chat::compaction::CompactionEntry>>(),
        None,
    )
    .await
    .ok()?;
    eprintln!(
        "[context] harness primer: summarized {head_count} older turn(s) ({head_chars} chars) via {}/{model}",
        provider_id.as_str(),
    );
    Some(summary)
}

/// DB key for the model id the harness LAST actually ran (assistant
/// message.model / message info.modelID). Feeds the composer's context meter
/// so it shows the real model — a custom/remapped harness setup used to keep
/// showing the session's stale catalog alias (opus/sonnet).
pub(crate) fn actual_model_key(harness: &str, sid: &str) -> String {
    format!("agent.actual_model.{harness}.{sid}")
}

/// Persist the harness's actual turn model (best-effort — display only).
pub(crate) fn persist_actual_model(db: &DbState, harness: &str, sid: &str, model: &str) {
    let conn = db.0.lock();
    let _ = crate::db::set_setting(&conn, &actual_model_key(harness, sid), model);
}
