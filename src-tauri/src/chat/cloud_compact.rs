//! Pre-send context compaction for CLOUD chat providers.
//!
//! Cloud providers historically got none of the local path's protection: the
//! full DB history shipped every turn and an over-window request died as a
//! raw 400. This module closes that gap by reusing the local pin+summarize
//! engine (`chat::compaction`) with two cloud-specific substitutions:
//!
//! - **Trigger**: no `/tokenize` endpoint exists for cloud APIs, so the
//!   request size is ESTIMATED (~4 chars/token — same constant the meter
//!   uses) against the model-registry window (`chat::context_windows`).
//! - **Summarizer**: instead of the same sidecar, the session's OWN provider
//!   is called non-streaming (OpenAI- or Anthropic-shaped, resolved by
//!   [`ChatProviderId`]), so the summary quality scales with the model that
//!   is doing the work.
//!
//! Everything else is shared: the pin-N-exchanges split, the single running
//! `[compacted context]` row, supersede-marking, and the status UX.
//!
//! Retry: `mod.rs` calls [`run_cloud_compaction`] a second time (forced) when
//! the provider rejects a turn with a context-overflow error, then re-runs
//! the turn with the rewritten request.

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::chat::compaction::{CompactionEntry, COMPACTED_PREFIX, RESPONSE_HEADROOM};
use crate::chat::providers::ChatProviderId;

/// Per-session cloud compaction config (`chat.cloud.*` settings keys).
#[derive(Debug, Clone)]
pub struct CloudCompactionConfig {
    /// Master switch. Compaction also runs on overflow-retry regardless —
    /// that is recovery, not prediction.
    pub enabled: bool,
    /// Fraction of the model window at which compaction triggers (0.25–0.99).
    pub threshold: f64,
    /// Recent exchanges (user+assistant pairs) pinned verbatim.
    pub pin_exchanges: usize,
    /// Rebuild-from-raw: when a prior summary exists, re-feed its raw source
    /// rows (they stay in the DB) into the compaction input so each new
    /// summary is re-derived from the ORIGINAL turns. Same contract as the
    /// local knob; only the settings key differs.
    pub rebuild_from_raw: bool,
}

impl Default for CloudCompactionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold: crate::chat::compaction::DEFAULT_THRESHOLD,
            pin_exchanges: crate::chat::compaction::DEFAULT_PIN_EXCHANGES,
            rebuild_from_raw: true,
        }
    }
}

/// Load the cloud compaction config from the settings store. Forgiving by
/// design: a bad stored value must never block a chat turn.
pub fn load_cloud_compaction_config(conn: &Connection) -> CloudCompactionConfig {
    let mut cfg = CloudCompactionConfig::default();
    if let Ok(Some(raw)) = crate::db::get_setting(conn, "chat.cloud.compaction_enabled") {
        cfg.enabled = !matches!(raw.trim(), "false" | "0" | "off");
    }
    if let Ok(Some(raw)) = crate::db::get_setting(conn, "chat.cloud.compaction_threshold") {
        if let Ok(v) = raw.trim().parse::<f64>() {
            if (0.25..=0.99).contains(&v) {
                cfg.threshold = v;
            }
        }
    }
    if let Ok(Some(raw)) = crate::db::get_setting(conn, "chat.cloud.compaction_pin_exchanges") {
        if let Ok(v) = raw.trim().parse::<usize>() {
            if (1..=50).contains(&v) {
                cfg.pin_exchanges = v;
            }
        }
    }
    if let Ok(Some(raw)) = crate::db::get_setting(conn, "chat.cloud.compaction_rebuild_from_raw") {
        cfg.rebuild_from_raw = !matches!(raw.trim(), "false" | "0" | "off");
    }
    cfg
}

/// Estimate the assembled request size in tokens (~4 chars/token). Mirrors
/// the meter's estimator and the backend `estimate_tokens` helper; cloud
/// APIs expose no tokenizer endpoint, so an estimate is the pre-send signal.
pub fn estimate_request_tokens(
    system: &Option<String>,
    messages: &[CompactionEntry],
    reserved_tokens: u32,
) -> u32 {
    let estimator = |s: &str| (s.chars().count() as u32 + 3) / 4;
    let mut total: u32 = reserved_tokens;
    if let Some(sys) = system {
        total = total.saturating_add(estimator(sys));
    }
    for m in messages {
        total = total.saturating_add(estimator(&m.message.content));
    }
    total
}

/// Run a non-streaming summarization call against the session's own cloud
/// provider. Returns `(summary_text, input_tokens, output_tokens)`.
pub(crate) async fn summarize_via_provider(
    client: &reqwest::Client,
    provider_id: ChatProviderId,
    base: &str,
    api_key: &str,
    model: &str,
    to_compact: &[&CompactionEntry],
    prior_summary: Option<&str>,
) -> Result<(String, i64, i64), String> {
    let system = crate::chat::compaction::summarization_system_prompt();
    let user = crate::chat::compaction::summarization_user_content(to_compact, prior_summary);
    let is_anthropic = matches!(
        provider_id,
        ChatProviderId::Anthropic | ChatProviderId::AnthropicCompatible
    );

    let (resp, parse): (reqwest::RequestBuilder, _) = if is_anthropic {
        let body = json!({
            "model": model,
            "stream": false,
            "max_tokens": 2048,
            "system": system,
            "messages": [{ "role": "user", "content": user }],
        });
        let req = client
            .post(format!("{base}/v1/messages"))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body);
        (
            req,
            Box::new(|v: Value| -> Result<(String, i64, i64), String> {
                let text = v
                    .get("content")
                    .and_then(|c| c.as_array())
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let usage = v.get("usage");
                let in_tok = usage
                    .and_then(|u| u.get("input_tokens"))
                    .and_then(|t| t.as_i64())
                    .unwrap_or(0);
                let out_tok = usage
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(|t| t.as_i64())
                    .unwrap_or(0);
                Ok((text, in_tok, out_tok))
            }) as Box<dyn Fn(Value) -> Result<(String, i64, i64), String> + Send>,
        )
    } else {
        // OpenAI / OpenRouter / compatible — the OpenAI wire shape.
        let body = json!({
            "model": model,
            "stream": false,
            "max_tokens": 2048,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
        });
        let req = client
            .post(format!("{base}/v1/chat/completions"))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("content-type", "application/json")
            .json(&body);
        (
            req,
            Box::new(|v: Value| -> Result<(String, i64, i64), String> {
                let text = v
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("message"))
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
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
            }) as Box<dyn Fn(Value) -> Result<(String, i64, i64), String> + Send>,
        )
    };

    let resp = resp
        .send()
        .await
        .map_err(|e| format!("summarize request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        eprintln!("[cloud-compaction] summarize FAILED status={status} body={err_body}");
        return Err(format!("summarize returned {status}: {err_body}"));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("summarize body parse failed: {e}"))?;
    let (text, in_tok, out_tok) = parse(v)?;
    if text.is_empty() {
        return Err("summarize returned empty content".to_string());
    }
    Ok((text, in_tok, out_tok))
}

/// A completed cloud compaction pass: the rewritten history plus everything
/// the caller needs to persist and report. DB writes stay with the caller
/// (the send path and the overflow-retry live in different contexts with
/// different lock scopes around the await points).
#[derive(Debug, Clone)]
pub struct CloudCompactionRun {
    /// Rewritten history: new summary row first, then the pinned tail.
    pub messages: Vec<crate::chat::providers::ChatMessage>,
    pub summary_text: String,
    pub summary_input_tokens: i64,
    pub summary_output_tokens: i64,
    /// DB ids folded into the new summary (aged-out turns + any prior
    /// summary row) — to be marked superseded by the caller.
    pub superseded_ids: Vec<i64>,
    pub compacted_exchange_count: usize,
    /// Estimated request size before/after (for the "Compacted X → Y" notice).
    pub pre_tokens: u32,
    pub post_tokens: u32,
}

/// Execute one cloud compaction pass: split (pin + aged-out head), summarize
/// via the provider, and assemble the rewritten history. Does NOT touch the
/// DB — see [`persist_summary_row`]. Returns `Err` when there is nothing to
/// compact or the summarizer failed; callers treat that as "send as-is".
#[allow(clippy::too_many_arguments)]
pub async fn run_cloud_compaction(
    client: &reqwest::Client,
    provider_id: ChatProviderId,
    base: &str,
    api_key: &str,
    model: &str,
    system: &Option<String>,
    entries: &[CompactionEntry],
    pin_exchanges: usize,
) -> Result<CloudCompactionRun, String> {
    let (prior, to_compact, pinned) =
        match crate::chat::compaction::split_for_compaction(entries, pin_exchanges) {
            Some(s) => s,
            None => return Err("nothing aged out to compact".to_string()),
        };

    let pre_tokens = estimate_request_tokens(system, entries, 0);
    let prior_text = prior.as_ref().map(|(_, t)| t.as_str());
    let (summary, in_tok, out_tok) =
        summarize_via_provider(client, provider_id, base, api_key, model, &to_compact, prior_text)
            .await?;

    let compacted_exchange_count = to_compact.iter().filter(|e| e.message.role == "user").count();
    let mut superseded_ids: Vec<i64> =
        to_compact.iter().map(|e| e.id).filter(|id| *id != 0).collect();
    if let Some((prior_id, _)) = &prior {
        if *prior_id != 0 {
            superseded_ids.push(*prior_id);
        }
    }

    let mut out_messages = Vec::with_capacity(pinned.len() + 1);
    out_messages.push(crate::chat::providers::ChatMessage {
        role: "system".to_string(),
        content: format!("{COMPACTED_PREFIX}\n\n{summary}"),
        images: Vec::new(),
    });
    for e in &pinned {
        out_messages.push(e.message.clone());
    }
    let post_tokens = {
        let est = |s: &str| (s.chars().count() as u32 + 3) / 4;
        let sys: u32 = system.as_ref().map(|s| est(s)).unwrap_or(0);
        sys + out_messages.iter().map(|m| est(&m.content)).sum::<u32>()
    };

    Ok(CloudCompactionRun {
        messages: out_messages,
        summary_text: summary,
        summary_input_tokens: in_tok,
        summary_output_tokens: out_tok,
        superseded_ids,
        compacted_exchange_count,
        pre_tokens: pre_tokens.saturating_add(RESPONSE_HEADROOM),
        post_tokens,
    })
}

/// Persist a compaction run: the `[compacted context]` summary row (with the
/// summarizer's token usage attributed for the cost dashboard) plus
/// supersede-marking of the folded rows. Returns the summary row id.
pub fn persist_summary_row(
    conn: &Connection,
    chat_session_id: &str,
    run: &CloudCompactionRun,
) -> Result<i64, String> {
    let summary_content = format!("{COMPACTED_PREFIX}\n\n{}", run.summary_text);
    let row = crate::db::add_chat_message(
        conn,
        chat_session_id,
        "system",
        &summary_content,
        Some(run.summary_input_tokens),
        Some(run.summary_output_tokens),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        // started_at, completed_at, llm, tool, ttft, tok_s
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .map_err(|e| e.to_string())?;
    if !run.superseded_ids.is_empty() {
        crate::db::mark_superseded(conn, &run.superseded_ids, row.id).map_err(|e| e.to_string())?;
    }
    Ok(row.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::providers::ChatMessage;

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
    fn config_defaults_and_clamping() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        let cfg = load_cloud_compaction_config(&conn);
        assert!(cfg.enabled);
        assert!((cfg.threshold - 0.75).abs() < 1e-9);
        assert_eq!(cfg.pin_exchanges, 6);

        crate::db::set_setting(&conn, "chat.cloud.compaction_enabled", "false").unwrap();
        crate::db::set_setting(&conn, "chat.cloud.compaction_threshold", "0.61").unwrap();
        crate::db::set_setting(&conn, "chat.cloud.compaction_pin_exchanges", "3").unwrap();
        let cfg = load_cloud_compaction_config(&conn);
        assert!(!cfg.enabled);
        assert!((cfg.threshold - 0.61).abs() < 1e-9);
        assert_eq!(cfg.pin_exchanges, 3);

        // Garbage clamps to defaults.
        crate::db::set_setting(&conn, "chat.cloud.compaction_threshold", "nope").unwrap();
        crate::db::set_setting(&conn, "chat.cloud.compaction_pin_exchanges", "9999").unwrap();
        crate::db::set_setting(&conn, "chat.cloud.compaction_enabled", "yes").unwrap();
        let cfg = load_cloud_compaction_config(&conn);
        assert!(cfg.enabled); // anything not in the off-list means on
        assert!((cfg.threshold - 0.75).abs() < 1e-9);
        assert_eq!(cfg.pin_exchanges, 6);
    }

    #[test]
    fn rebuild_from_raw_defaults_on_and_parses_off_values() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        assert!(load_cloud_compaction_config(&conn).rebuild_from_raw);
        crate::db::set_setting(&conn, "chat.cloud.compaction_rebuild_from_raw", "off").unwrap();
        assert!(!load_cloud_compaction_config(&conn).rebuild_from_raw);
        crate::db::set_setting(&conn, "chat.cloud.compaction_rebuild_from_raw", "true").unwrap();
        assert!(load_cloud_compaction_config(&conn).rebuild_from_raw);
    }

    #[test]
    fn estimate_counts_system_messages_and_reserved() {
        let msgs = vec![entry(1, "user", "abcd"), entry(2, "assistant", "abcdabcd")];
        let sys = Some("abcdabcd".to_string()); // 2 tokens
        // 8 chars/4 = 2 (system) + 1 + 2 (messages) + 7 (reserved) = 12.
        assert_eq!(estimate_request_tokens(&sys, &msgs, 7), 12);
        assert_eq!(estimate_request_tokens(&None, &msgs, 0), 3);
    }

    #[test]
    fn run_errors_when_nothing_to_compact() {
        // 6 exchanges pinned with pin_exchanges=6 → nothing aged out.
        let msgs: Vec<CompactionEntry> = (0..12)
            .map(|i| {
                let role = if i % 2 == 0 { "user" } else { "assistant" };
                entry(i, role, "x")
            })
            .collect();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let result = rt.block_on(async {
            let client = reqwest::Client::new();
            run_cloud_compaction(
                &client,
                ChatProviderId::OpenAI,
                "http://127.0.0.1:1",
                "k",
                "m",
                &None,
                &msgs,
                6,
            )
            .await
        });
        assert!(result.is_err());
    }
}
