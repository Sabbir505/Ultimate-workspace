//! Automatic context compaction for local (LocalGguf) chat sessions.
//!
//! Local models run with hardware-constrained context windows (4K–16K tokens,
//! set at sidecar spawn in [`crate::chat::local_models`]). A long conversation
//! eventually overflows that window and either 400-errors mid-task or silently
//! truncates via llama-server's crude oldest-token-dropping context-shifting
//! (no regard for importance). This module proactively condenses older history
//! before the window fills, so long local-model sessions keep working.
//!
//! Strategy (hybrid pin + summarize):
//! - **Never touch** the system prompt.
//! - **Pin verbatim** the most recent N *exchanges* (user+assistant pairs) —
//!   recency dominates coherence, so these go through unchanged.
//! - **Summarize** everything between the system prompt and the pinned tail.
//!   A separate non-streaming inference call to the same sidecar produces a
//!   running summary; resolved back-and-forth and pleasantries are dropped,
//!   key facts / decisions / file paths / identifiers are preserved.
//! - On re-compaction, a prior `[compacted context]` summary row is folded
//!   into the new summarization call and itself superseded, so exactly ONE
//!   running summary block ever exists — no stacking.
//!
//! Scope: `ChatProviderId::LocalGguf` only. API providers have large windows
//! and are out of scope; the send path gates the hook, not this module, so the
//! module adds no overhead for non-local providers.
//!
//! Fallback: if token-counting or summarization errors (or the session still
//! overflows immediately after compacting), the turn proceeds with the
//! original history untouched and an `eprintln!` is logged — llama-server's
//! built-in context-shifting then degrades the turn rather than breaking it.

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::chat::providers::ChatMessage;

/// Prefix that marks a `role="system"` DB row as a compaction summary (so the
/// send path and this module can identify and fold a prior summary on
/// re-compaction). The marker text the frontend renders is derived separately
/// in the message-rendering layer; this is the internal, persisted sentinel.
pub const COMPACTED_PREFIX: &str = "[compacted context]";

/// Default compaction threshold (fraction of `n_ctx`) below the API's own
/// 0.92 reference point — local models have proportionally less headroom and
/// the summarization call itself must fit in what's left, so 0.75 is the
/// safer default. Tunable via `chat.local_gguf.compaction_threshold`.
pub const DEFAULT_THRESHOLD: f64 = 0.75;

/// Default number of recent *exchanges* (1 exchange = user + assistant) pinned
/// verbatim. Tunable via `chat.local_gguf.compaction_pin_exchanges`.
pub const DEFAULT_PIN_EXCHANGES: usize = 6;

/// Reserved response headroom (in tokens) added to the current token count
/// before comparing against the threshold, so a turn that would itself push
/// the window over the line triggers compaction a step early rather than
/// overflowing on the response.
const RESPONSE_HEADROOM: u32 = 512;

/// Per-session compaction config, loaded from the key/value settings store.
#[derive(Debug, Clone)]
pub struct CompactionConfig {
    /// Fraction of `n_ctx` (0.0–1.0) at which compaction triggers.
    pub threshold: f64,
    /// Number of recent *exchanges* (user+assistant pairs) pinned verbatim.
    pub pin_exchanges: usize,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            threshold: DEFAULT_THRESHOLD,
            pin_exchanges: DEFAULT_PIN_EXCHANGES,
        }
    }
}

/// Load compaction config from the settings store, falling back to the
/// documented defaults on a missing/unparseable value. Kept forgiving because
/// a bad stored value must never block a chat turn.
pub fn load_compaction_config(conn: &Connection) -> CompactionConfig {
    let mut cfg = CompactionConfig::default();
    if let Ok(Some(raw)) = crate::db::get_setting(conn, "chat.local_gguf.compaction_threshold")
    {
        if let Ok(v) = raw.trim().parse::<f64>() {
            // Clamp to a sane band; anything outside is treated as the default.
            if (0.25..=0.99).contains(&v) {
                cfg.threshold = v;
            }
        }
    }
    if let Ok(Some(raw)) = crate::db::get_setting(conn, "chat.local_gguf.compaction_pin_exchanges")
    {
        if let Ok(v) = raw.trim().parse::<usize>() {
            if (1..=50).contains(&v) {
                cfg.pin_exchanges = v;
            }
        }
    }
    cfg
}

/// A message the orchestrator operates on: its DB id (so superseded rows can
/// be marked) alongside the cleaned wire message. `id` is `0` for a
/// synthesized summary that hasn't been persisted yet.
#[derive(Debug, Clone)]
pub struct CompactionEntry {
    pub id: i64,
    pub message: ChatMessage,
}

/// Result of a compaction pass.
#[derive(Debug, Clone)]
pub struct CompactionOutcome {
    /// Rewritten history to send to the model: the new (or carried) summary
    /// row first, then the pinned recent turns. Superseded originals are
    /// dropped. Unchanged when `did_compact` is false.
    pub messages: Vec<ChatMessage>,
    pub did_compact: bool,
    /// The summary text (without the `[compacted context]` prefix) — for both
    /// the persisted DB row's content and the frontend marker's reveal.
    pub summary_text: String,
    pub summary_input_tokens: i64,
    pub summary_output_tokens: i64,
    /// DB ids folded into the new summary: both the aged-out real turns AND
    /// any prior summary row (so re-compaction collapses into one block).
    pub superseded_ids: Vec<i64>,
    /// How many exchanges were condensed — purely for marker text.
    pub compacted_exchange_count: usize,
}

impl CompactionOutcome {
    /// No-op outcome: pass the original messages through unchanged.
    fn passthrough(messages: Vec<ChatMessage>) -> Self {
        Self {
            messages,
            did_compact: false,
            summary_text: String::new(),
            summary_input_tokens: 0,
            summary_output_tokens: 0,
            superseded_ids: Vec::new(),
            compacted_exchange_count: 0,
        }
    }
}

/// Serialize the system prompt + message history into a single string in a
/// rough chat-template form for `/tokenize`. llama-server's `/tokenize`
/// accepts arbitrary text and returns the token count the model's tokenizer
/// would produce; passing the assembled conversation (rather than summing
/// per-message counts) most closely approximates what the model actually sees,
/// including role/control tokens the chat template injects.
pub fn assemble_for_tokenization(system: &Option<String>, messages: &[ChatMessage]) -> String {
    let mut s = String::new();
    if let Some(sys) = system {
        if !sys.trim().is_empty() {
            s.push_str("<|system|>\n");
            s.push_str(sys);
            s.push_str("\n");
        }
    }
    for m in messages {
        s.push_str(&format!("<|{}|>\n{}\n", m.role, m.content));
    }
    s
}

/// Count tokens for the assembled system+messages via `POST {base}/tokenize`.
/// llama-server returns `{ "tokens": [...] }`; the count is the array length.
/// Errors propagate to the caller, which treats them as a compaction fallback.
pub async fn count_tokens(
    client: &reqwest::Client,
    base_url: &str,
    system: &Option<String>,
    messages: &[ChatMessage],
) -> Result<u32, String> {
    let content = assemble_for_tokenization(system, messages);
    let url = format!("{base_url}/tokenize");
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&json!({ "content": content }))
        .send()
        .await
        .map_err(|e| format!("/tokenize request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("/tokenize returned {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("/tokenize body parse failed: {e}"))?;
    let n = body
        .get("tokens")
        .and_then(|t| t.as_array())
        .map(|a| a.len() as u32)
        .ok_or_else(|| "/tokenize response missing \"tokens\" array".to_string())?;
    Ok(n)
}

/// Count tokens for arbitrary raw text via `POST {base}/tokenize` — used for
/// the tool-schema overhead, which the send path adds on top of the assembled
/// system+history and which therefore must be reserved out of the compaction
/// budget (otherwise the window "fits" by the count but the real request 400s
/// with exceed_context_size_error). Errors propagate to the caller, which
/// treats them as a compaction fallback.
pub async fn count_json_tokens(
    client: &reqwest::Client,
    base_url: &str,
    text: &str,
) -> Result<u32, String> {
    let url = format!("{base_url}/tokenize");
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&json!({ "content": text }))
        .send()
        .await
        .map_err(|e| format!("/tokenize request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("/tokenize returned {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("/tokenize body parse failed: {e}"))?;
    let n = body
        .get("tokens")
        .and_then(|t| t.as_array())
        .map(|a| a.len() as u32)
        .ok_or_else(|| "/tokenize response missing \"tokens\" array".to_string())?;
    Ok(n)
}

/// Is this message the existing running compaction summary? Identified by
/// `role == "system"` and content starting with the `[compacted context]`
/// sentinel. Pulled out of the pin/compact split and folded into the new
/// summarization call instead.
fn is_compacted_summary(m: &ChatMessage) -> bool {
    m.role == "system" && m.content.trim_start().starts_with(COMPACTED_PREFIX)
}

/// Strip the `[compacted context]` sentinel + any framing whitespace from a
/// prior summary row so only the prose goes into the new summarization prompt.
fn strip_compacted_prefix(content: &str) -> String {
    let t = content.trim_start();
    let after = t.strip_prefix(COMPACTED_PREFIX).unwrap_or(t);
    after.trim_start_matches([':', ' ', '\n']).to_string()
}

/// Partition the active message list into (prior_summary, to_compact, pinned).
///
/// - `prior_summary`: any existing `[compacted context]` system row (at most
///   one by construction). Excluded from the pin and from compaction target;
///   folded into the new summarization call.
/// - `pinned`: the last `pin_exchanges*2` messages of whatever remains after
///   removing the prior summary. These go to the model verbatim.
/// - `to_compact`: everything between the prior summary and the pinned tail
///   (i.e. aged-out real turns). These get summarized.
///
/// Returns `None` when there's nothing to compact (no `to_compact`).
fn split_for_compaction(
    messages: &[CompactionEntry],
    pin_exchanges: usize,
) -> Option<(
    Option<(i64, String)>, // prior summary (id, text)
    Vec<&CompactionEntry>, // to_compact
    Vec<&CompactionEntry>, // pinned
)> {
    // Pull out a prior summary, if present.
    let prior_idx = messages.iter().position(|e| is_compacted_summary(&e.message));
    let prior = prior_idx.and_then(|i| {
        let e = &messages[i];
        Some((e.id, strip_compacted_prefix(&e.message.content)))
    });

    // The remaining messages (everything except the prior summary) are split
    // into a compactable head and a pinned tail.
    let remaining: Vec<&CompactionEntry> = messages
        .iter()
        .enumerate()
        .filter(|(i, _)| Some(*i) != prior_idx)
        .map(|(_, e)| e)
        .collect();

    let pin_msgs = pin_exchanges.saturating_mul(2).min(remaining.len());
    if remaining.len() <= pin_msgs {
        // Nothing aged out to summarize — no compaction possible.
        return None;
    }
    let split_at = remaining.len() - pin_msgs;
    let to_compact: Vec<&CompactionEntry> = remaining[..split_at].to_vec();
    let pinned: Vec<&CompactionEntry> = remaining[split_at..].to_vec();
    if to_compact.is_empty() {
        return None;
    }
    Some((prior, to_compact, pinned))
}

/// The summarization system instruction, written for a small/local model:
/// explicit, listy, no preamble — consistent with the STRICT-addendum voice in
/// `chat/prompts.rs`.
fn summarization_system_prompt() -> &'static str {
    "You are a conversation-summarizing assistant. You will be given an \
    excerpt of an earlier conversation (and optionally a prior summary of even \
    earlier turns). Produce ONE tight summary that preserves, in bullet-like \
    prose: key facts stated, decisions made, and any file paths, code \
    snippets, URLs, or identifiers mentioned. Explicitly DISCARD resolved \
    back-and-forth, troubleshooting that reached a dead end, and pleasantries. \
    Do not add commentary, do not ask questions, do not mention that you are \
    summarizing. Output the summary only."
}

/// Build the user content for the summarization call: the prior running
/// summary (if any) followed by the aged-out turns to condense, rendered in a
/// chat-template-ish form so the model can tell roles apart.
fn summarization_user_content(
    to_compact: &[&CompactionEntry],
    prior_summary: Option<&str>,
) -> String {
    let mut s = String::new();
    if let Some(p) = prior_summary {
        s.push_str("Prior summary of earlier turns (already condensed):\n");
        s.push_str(p);
        s.push_str("\n\n");
    }
    s.push_str("Conversation excerpt to condense into the summary above:\n");
    for e in to_compact {
        s.push_str(&format!("\n[{}]\n{}\n", e.message.role, e.message.content));
    }
    s
}

/// Run a non-streaming `/v1/chat/completions` summarization call against the
/// same sidecar. Returns `(summary_text, input_tokens, output_tokens)`.
/// `model` is the active local model id (used only so llama-server picks the
/// loaded model; it ignores the value otherwise).
async fn summarize(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    to_compact: &[&CompactionEntry],
    prior_summary: Option<&str>,
) -> Result<(String, i64, i64), String> {
    // Truncate the user content defensively. llama-server will 400 on a
    // summarization request whose user content alone overflows the model's
    // context window — and the entire to_compact head (the oldest half of
    // the conversation) gets dumped into ONE user message. For a 4K-ctx
    // model with 30+ prior turns, that's 6–8K tokens, way over the cap. We
    // cap at ¾ of the sidecar's n_ctx (read from the running model by the
    // caller) so the request body is always a comfortable fit. The summary
    // task is lossy by design — losing the tail of `to_compact` to keep the
    // request valid is strictly better than a 400 that aborts compaction
    // entirely (the fallback is context-shifting on the next send, which is
    // the very thing compaction exists to avoid).
    //
    // The caller passes the n_ctx in via the existing `model` parameter slot
    // doesn't carry it, so we thread a separate field. The call sites in
    // maybe_compact already know n_ctx — pass it through.
    let url = format!("{base_url}/v1/chat/completions");
    let mut body = json!({
        "model": model,
        "stream": false,
        "max_tokens": 1024,
        "messages": [
            { "role": "system", "content": summarization_system_prompt() },
            { "role": "user", "content": summarization_user_content(to_compact, prior_summary) },
        ],
    });
    let json_body = serde_json::to_string(&body).unwrap_or_default();
    eprintln!(
        "[local-compaction] summarize → POST {url} body_len={}",
        json_body.len()
    );
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .body(json_body)
        .send()
        .await
        .map_err(|e| format!("summarize request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        eprintln!(
            "[local-compaction] summarize FAILED status={status} body={err_body}"
        );
        return Err(format!("summarize returned {status}: {err_body}"));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("summarize body parse failed: {e}"))?;
    let text = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| "summarize response missing choices[0].message.content".to_string())?
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("summarize returned empty content".to_string());
    }
    let usage = v.get("usage");
    let in_tok = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|t| t.as_i64())
        .unwrap_or(0);
    let out_tok = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|t| t.as_i64())
        .unwrap_or(0);
    Ok((text, in_tok, out_tok))
}

/// Orchestrator. Called once per local-model turn, after history is rebuilt
/// from the DB and cleaned.
///
/// Decides whether the assembled (system + history) exceeds the configured
/// threshold of the effective context (n_ctx minus the tokens reserved for
/// the send-time tool schema + response headroom); if so, splits, summarizes,
/// and returns the rewritten message list plus the DB writes to perform.
/// On any failure — or if compaction still wouldn't fit — returns the original
/// messages unchanged (`did_compact=false`) so the turn proceeds and
/// llama-server's context-shifting degrades rather than breaks.
///
/// `messages` carry their DB `id` (0 for the not-yet-persisted live user
/// message, which is always pinned and never compacted).
pub async fn maybe_compact(
    client: &reqwest::Client,
    base_url: &str,
    n_ctx: u32,
    model: &str,
    system: &Option<String>,
    messages: &[CompactionEntry],
    cfg: &CompactionConfig,
    reserved_tokens: u32,
) -> Result<CompactionOutcome, String> {
    if n_ctx == 0 {
        return Ok(CompactionOutcome::passthrough(messages.iter().map(|e| e.message.clone()).collect()));
    }
    // Effective window: what the request has left after the tool schema (and
    // other send-time overhead) the caller reserved. If the overhead alone
    // fills the window, compaction can't help — pass history through and let
    // llama-server context-shift.
    let effective_ctx = n_ctx.saturating_sub(reserved_tokens);
    if effective_ctx == 0 {
        eprintln!(
            "[local-compaction] reserved overhead ({reserved_tokens} tokens) fills the \
            {n_ctx}-token window; skipping compaction (context-shifting will degrade)"
        );
        return Ok(CompactionOutcome::passthrough(messages.iter().map(|e| e.message.clone()).collect()));
    }

    let wire_messages: Vec<ChatMessage> = messages.iter().map(|e| e.message.clone()).collect();
    let tokens = match count_tokens(client, base_url, system, &wire_messages).await {
        Ok(n) => n,
        Err(e) => {
            eprintln!(
                "[local-compaction] /tokenize failed ({e}); passing history through \
                unchanged (llama-server context-shifting will degrade if needed)"
            );
            return Ok(CompactionOutcome::passthrough(wire_messages));
        }
    };

    let trigger = ((effective_ctx as f64) * cfg.threshold) as u32;
    if tokens.saturating_add(RESPONSE_HEADROOM) < trigger {
        return Ok(CompactionOutcome::passthrough(wire_messages));
    }

    let (prior, to_compact, pinned) = match split_for_compaction(&messages, cfg.pin_exchanges) {
        Some(s) => s,
        None => return Ok(CompactionOutcome::passthrough(wire_messages)),
    };

    // If even the pinned tail + system would overflow, summarizing won't help
    // (the window is too small for the pinned turns alone). Fall back and let
    // context-shifting handle it — log so it's visible during testing.
    if let Ok(pinned_tokens) =
        count_tokens(client, base_url, system, &pinned.iter().map(|e| e.message.clone()).collect::<Vec<_>>()).await
    {
        if pinned_tokens.saturating_add(RESPONSE_HEADROOM) >= effective_ctx {
            eprintln!(
                "[local-compaction] pinned tail ({pinned_tokens} tokens) already fills \
                the {effective_ctx}-token window; skipping compaction (context-shifting will degrade)"
            );
            return Ok(CompactionOutcome::passthrough(wire_messages));
        }
    }

    // Truncate `to_compact` so the summarization request is always a
    // comfortable fit. The summarization call dumps the whole `to_compact`
    // head into ONE user message, and llama-server 400s when that user
    // content alone exceeds the model's context window. We cap the user
    // content at ¾ of the sidecar's n_ctx (rough char/token ratio of 4 chars
    // per token is plenty for a safety margin). Pin ordering already keeps
    // the most recent tail verbatim, so truncating from the OLD end of
    // to_compact is the right direction — we lose the oldest summarized
    // detail, not the recent context.
    let mut to_compact_truncated: Vec<&CompactionEntry> = Vec::new();
    let mut chars: usize = 0;
    {
        let max_chars = ((n_ctx as usize) * 3 / 4).max(1024);
        // Iterate from OLDEST → NEWEST, but we want to KEEP the NEWEST, so
        // reverse-walk and add while we have headroom.
        for e in to_compact.iter().rev() {
            let added = e.message.content.len();
            if chars + added > max_chars && !to_compact_truncated.is_empty() {
                break;
            }
            to_compact_truncated.push(*e);
            chars += added;
        }
        to_compact_truncated.reverse();
    }
    if to_compact_truncated.len() < to_compact.len() {
        eprintln!(
            "[local-compaction] to_compact truncated: {} → {} entries ({} chars; n_ctx={})",
            to_compact.len(),
            to_compact_truncated.len(),
            chars,
            n_ctx
        );
    }

    let prior_text = prior.as_ref().map(|(_, t)| t.as_str());
    let (summary, in_tok, out_tok) = match summarize(client, base_url, model, &to_compact_truncated, prior_text).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "[local-compaction] summarize failed ({e}); passing history through \
                unchanged (context-shifting will degrade if needed)"
            );
            return Ok(CompactionOutcome::passthrough(wire_messages));
        }
    };

    let compacted_exchange_count = to_compact.iter().filter(|e| e.message.role == "user").count();
    let mut superseded_ids: Vec<i64> = to_compact.iter().map(|e| e.id).filter(|id| *id != 0).collect();
    if let Some((prior_id, _)) = &prior {
        if *prior_id != 0 {
            superseded_ids.push(*prior_id);
        }
    }

    // Rewritten history: new summary row first, then the pinned tail verbatim.
    let mut out_messages = Vec::with_capacity(pinned.len() + 1);
    out_messages.push(ChatMessage {
        role: "system".to_string(),
        content: format!("{COMPACTED_PREFIX}\n\n{summary}"),
        images: Vec::new(),
    });
    for e in &pinned {
        out_messages.push(e.message.clone());
    }

    Ok(CompactionOutcome {
        messages: out_messages,
        did_compact: true,
        summary_text: summary,
        summary_input_tokens: in_tok,
        summary_output_tokens: out_tok,
        superseded_ids,
        compacted_exchange_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: i64, role: &str, content: &str) -> CompactionEntry {
        CompactionEntry {
            id,
            message: ChatMessage {
                role: role.to_string(),
                content: content.to_string(),
                images: Vec::new(),
            },
        }
    }

    #[test]
    fn split_no_compaction_when_only_pinned_fits() {
        // 6 exchanges = 12 messages, pin_exchanges=6 → nothing to compact.
        let mut msgs = Vec::new();
        for i in 0..12 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            msgs.push(entry(i, role, "x"));
        }
        assert!(split_for_compaction(&msgs, 6).is_none());
    }

    #[test]
    fn split_compacts_aged_out_head_pins_tail() {
        // 8 exchanges (16 msgs), pin 6 → compact 4 msgs (2 exchanges), pin 12.
        let mut msgs = Vec::new();
        for i in 0..16 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            msgs.push(entry(i, role, &format!("turn {i}")));
        }
        let (prior, to_compact, pinned) = split_for_compaction(&msgs, 6).unwrap();
        assert!(prior.is_none());
        assert_eq!(to_compact.len(), 4);
        assert_eq!(pinned.len(), 12);
        // Pinned tail is the most recent 12 (ids 4..16).
        assert_eq!(pinned.first().unwrap().id, 4);
        assert_eq!(pinned.last().unwrap().id, 15);
        // Compacted head is the oldest 4 (ids 0..4).
        assert_eq!(to_compact.first().unwrap().id, 0);
        assert_eq!(to_compact.last().unwrap().id, 3);
    }

    #[test]
    fn split_pulls_prior_summary_out_of_pin_and_compact() {
        // A prior summary at id 0 (oldest), then 8 exchanges, pin 6.
        let mut msgs = vec![entry(0, "system", "[compacted context]\n\nold summary")];
        for i in 1..17 {
            let role = if i % 2 == 1 { "user" } else { "assistant" };
            msgs.push(entry(i, role, &format!("turn {i}")));
        }
        let (prior, to_compact, pinned) = split_for_compaction(&msgs, 6).unwrap();
        // Prior summary was extracted.
        let prior = prior.unwrap();
        assert_eq!(prior.0, 0);
        assert_eq!(prior.1, "old summary");
        // The 16 real messages split into compact(4) + pin(12).
        assert_eq!(to_compact.len(), 4);
        assert_eq!(pinned.len(), 12);
        // None of the pinned/compacted is the prior summary row.
        assert!(to_compact.iter().all(|e| e.id != 0));
        assert!(pinned.iter().all(|e| e.id != 0));
    }

    #[test]
    fn stripped_prefix_removes_sentinel_and_framing() {
        assert_eq!(
            strip_compacted_prefix("[compacted context]\n\nthe real summary"),
            "the real summary"
        );
        assert_eq!(strip_compacted_prefix("[compacted context]: the summary"), "the summary");
        assert_eq!(strip_compacted_prefix("  [compacted context]\nsummary"), "summary");
    }

    #[test]
    fn load_config_defaults_when_absent() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let cfg = load_compaction_config(&conn);
        assert_eq!(cfg.threshold, DEFAULT_THRESHOLD);
        assert_eq!(cfg.pin_exchanges, DEFAULT_PIN_EXCHANGES);
    }

    #[test]
    fn load_config_reads_stored_values() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        crate::db::set_setting(&conn, "chat.local_gguf.compaction_threshold", "0.8").unwrap();
        crate::db::set_setting(&conn, "chat.local_gguf.compaction_pin_exchanges", "3").unwrap();
        let cfg = load_compaction_config(&conn);
        assert_eq!(cfg.threshold, 0.8);
        assert_eq!(cfg.pin_exchanges, 3);
    }

    #[test]
    fn load_config_clamps_garbage_to_defaults() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        crate::db::set_setting(&conn, "chat.local_gguf.compaction_threshold", "not a number").unwrap();
        crate::db::set_setting(&conn, "chat.local_gguf.compaction_pin_exchanges", "999").unwrap();
        let cfg = load_compaction_config(&conn);
        assert_eq!(cfg.threshold, DEFAULT_THRESHOLD);
        assert_eq!(cfg.pin_exchanges, DEFAULT_PIN_EXCHANGES);
    }
}
