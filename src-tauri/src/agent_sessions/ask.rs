//! RELAY_ASK question channel: parsing, repair, follow-up composition, and surfacing — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;
// ------------------------------------------------- persistent OpenCode server
// ---- RELAY_ASK: the question channel for harnesses with no native ask mechanism ----
// Claude Code asks over its stdio control protocol; kimi/opencode/pi/omp/
// commandcode run headless with stdin closed and no question event. Their
// channel is a MARKER in the reply text: the per-turn prompt carries the
// directive below, the reader scans the finished reply for the marker,
// strips it from the persisted message, and surfaces the question card. The
// user's answer dispatches a follow-up turn on the CLI's resumed session —
// there is no live process to resume, so "paused mid-turn" is impossible by
// construction; the answer always arrives as the next user message.

pub(super) const RELAY_ASK_MARKER: &str = "RELAY_ASK:";

pub(super) const RELAY_ASK_DIRECTIVE: &str = "[RELAY QUESTION CHANNEL] When — and only when — the user's decision is required before you can proceed, end your reply with ONE final line of exactly this form:\n\
RELAY_ASK: {\"question\":\"<the question>\",\"header\":\"<2-4 words>\",\"options\":[{\"label\":\"<option>\",\"description\":\"<why pick it>\"}],\"multiSelect\":false}\n\
Then stop immediately: Relay surfaces it as an answer card and the user's reply arrives as your next user message. The line must be single-line VALID JSON — double every backslash in Windows paths (D:\\\\dir, never D:\\dir). Use it at most once per reply, never for optional confirmations you can decide yourself.";

/// Which harnesses carry the RELAY_ASK directive. claude_code has the stdio
/// control protocol (AskUserQuestion), ACP agents have their own session
/// protocol — both must NOT get the text directive.
pub(super) fn harness_question_channel(harness: &str) -> bool {
    matches!(
        harness,
        "kimi_code" | "opencode" | "pi" | "omp" | "commandcode"
    )
}

/// Models keep emitting single backslashes inside JSON strings ("D:\artifact"
/// — `\a` is not a valid JSON escape), which makes the whole marker line
/// unparseable. Re-escape any backslash that doesn't already start a valid
/// JSON escape so the line parses. Already-valid sequences (`\"`, `\\`,
/// `\n`, `\u00e9`, …) pass through untouched.
pub(super) fn repair_json_escapes(s: &str) -> String {
    const VALID: &[char] = &['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'];
    let mut out = String::with_capacity(s.len() + 8);
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some(n) if VALID.contains(&n) => {
                    out.push('\\');
                    out.push(n);
                }
                Some(n) => {
                    out.push_str("\\\\");
                    out.push(n);
                }
                None => out.push_str("\\\\"),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Scan a finished harness reply for the RELAY_ASK marker. The LAST line
/// carrying the marker wins (models sometimes add prose after it despite the
/// directive); the line only counts once its JSON parses — strictly first,
/// then with invalid escapes repaired — so ordinary text mentioning
/// "RELAY_ASK:" is never mistaken for a question. Returns the reply with the
/// marker line stripped (so the internal channel never leaks into the
/// persisted transcript) plus the normalized questions array for the
/// question card. `None` questions = no marker (the reply is returned
/// unchanged).
pub(super) fn split_relay_ask(full: String) -> (String, Option<serde_json::Value>) {
    if full.trim().is_empty() {
        return (full, None);
    }
    let mut lines: Vec<&str> = full.lines().collect();
    let Some(idx) = lines
        .iter()
        .rposition(|l| l.trim_start().starts_with(RELAY_ASK_MARKER))
    else {
        return (full, None);
    };
    // Tolerate the model wrapping the JSON in backticks.
    let rest = lines[idx]
        .trim()
        .strip_prefix(RELAY_ASK_MARKER)
        .unwrap_or("")
        .trim()
        .trim_matches('`')
        .trim();
    let parsed = serde_json::from_str::<serde_json::Value>(rest)
        .ok()
        .or_else(|| serde_json::from_str::<serde_json::Value>(&repair_json_escapes(rest)).ok());
    let Some(v) = parsed else {
        return (full, None);
    };
    let Some(question) = v
        .get("question")
        .and_then(|q| q.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
    else {
        return (full, None);
    };
    let mut obj = serde_json::Map::new();
    obj.insert("question".into(), serde_json::json!(question));
    if let Some(h) = v
        .get("header")
        .and_then(|h| h.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        obj.insert("header".into(), serde_json::json!(h));
    }
    if let Some(opts) = v.get("options").and_then(|o| o.as_array()) {
        let norm: Vec<serde_json::Value> = opts
            .iter()
            .filter_map(|o| {
                let label = o.get("label").and_then(|l| l.as_str())?;
                let mut m = serde_json::Map::new();
                m.insert("label".into(), serde_json::json!(label));
                if let Some(d) = o.get("description").and_then(|d| d.as_str()) {
                    m.insert("description".into(), serde_json::json!(d));
                }
                Some(serde_json::Value::Object(m))
            })
            .collect();
        if !norm.is_empty() {
            obj.insert("options".into(), serde_json::Value::Array(norm));
        }
    }
    if let Some(ms) = v.get("multiSelect").and_then(|m| m.as_bool()) {
        obj.insert("multiSelect".into(), serde_json::json!(ms));
    }
    lines.remove(idx);
    let clean = lines.join("\n").trim_end().to_string();
    (
        clean,
        Some(serde_json::Value::Array(vec![serde_json::Value::Object(
            obj,
        )])),
    )
}

/// Build the follow-up user message that delivers the card's answer to the
/// asking harness (its next turn resumes the session, so this reads as the
/// continuation of the same conversation).
/// asking turn is already finished and persisted by the time this runs).
/// Also used by `resolve_agent_question` to build the follow-up content.
pub(crate) fn compose_ask_follow_up(
    questions: &serde_json::Value,
    answers: &serde_json::Value,
    response: Option<&str>,
    skipped: bool,
) -> String {
    let q_text = questions
        .get(0)
        .and_then(|q| q.get("question"))
        .and_then(|q| q.as_str())
        .unwrap_or("your question");
    if skipped {
        return format!(
            "You asked: \u{201c}{q_text}\u{201d}. The user dismissed the question without answering \u{2014} continue with your best judgment and state any assumption you make."
        );
    }
    let mut body = format!("You asked: \u{201c}{q_text}\u{201d}.\n\nThe user's answer:");
    let mut any = false;
    if let Some(map) = answers.as_object() {
        for (q, a) in map {
            any = true;
            if let Some(labels) = a.as_array() {
                let joined: Vec<&str> = labels.iter().filter_map(|l| l.as_str()).collect();
                body.push_str(&format!("\n- \u{2022} {q}: {}", joined.join(", ")));
            } else if let Some(label) = a.as_str() {
                body.push_str(&format!("\n- \u{2022} {q}: {label}"));
            }
        }
    }
    if let Some(free) = response.map(str::trim).filter(|s| !s.is_empty()) {
        if any {
            body.push_str(&format!("\n\nThe user also wrote: \u{201c}{free}\u{201d}"));
        } else {
            body.push_str(&format!(" \u{201c}{free}\u{201d}"));
        }
    }
    body.push_str("\n\nContinue the task with these answers.");
    body
}

/// Register a surfaced RELAY_ASK question and emit the question card. The
/// answer comes back through `resolve_agent_question` →
/// `dispatch_ask_follow_up` (nothing blocks: the asking turn is already
/// finished and persisted by the time this runs).
pub(super) fn surface_relay_ask(app: Option<&AppHandle>, sid: &str, questions: serde_json::Value) {
    let Some(app) = app else { return };
    let Some(state) = app.try_state::<AgentSessionState>() else {
        return;
    };
    let pending_id =
        state
            .0
            .register_pending_ask(sid, questions.clone(), PendingAskRoute::FollowUpTurn);
    let _ = app.emit(
        "chat:question-request",
        crate::types::ChatQuestionRequestPayload {
            chat_session_id: sid.to_string(),
            pending_id,
            questions,
        },
    );
}

/// Surface opencode's NATIVE `question` tool request: the server has parked
/// the in-flight turn on this request id until we POST an answer (or reject
/// it). The card goes out immediately; the answer routes straight back to
/// the server — the turn then completes on its own.
pub(super) fn surface_opencode_question(
    app: Option<&AppHandle>,
    sid: &str,
    base_url: &str,
    oc_session_id: &str,
    request_id: &str,
    questions: serde_json::Value,
) {
    let Some(app) = app else { return };
    let Some(state) = app.try_state::<AgentSessionState>() else {
        return;
    };
    let pending_id = state.0.register_pending_ask(
        sid,
        questions.clone(),
        PendingAskRoute::OpenCode {
            base_url: base_url.to_string(),
            oc_session_id: oc_session_id.to_string(),
            request_id: request_id.to_string(),
        },
    );
    let _ = app.emit(
        "chat:question-request",
        crate::types::ChatQuestionRequestPayload {
            chat_session_id: sid.to_string(),
            pending_id,
            questions,
        },
    );
}

/// Map the card's answers (`{questionText: label | labels[]}` + optional
/// free text) onto opencode's reply body: `{answers: [[label,…], …]}` — one
/// label array PER QUESTION, in question order.
pub(crate) fn build_opencode_reply_answers(
    questions: &serde_json::Value,
    answers: &serde_json::Value,
    response: Option<&str>,
) -> serde_json::Value {
    let free = response.map(str::trim).filter(|s| !s.is_empty());
    let mut out: Vec<serde_json::Value> = Vec::new();
    for q in questions.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let qt = q.get("question").and_then(|v| v.as_str()).unwrap_or("");
        let mut labels: Vec<String> = match answers.get(qt) {
            Some(serde_json::Value::String(s)) => vec![s.clone()],
            Some(serde_json::Value::Array(a)) => a
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
            _ => vec![],
        };
        // A free-text reply answers whichever question went unanswered.
        if labels.is_empty() {
            if let Some(f) = free {
                labels.push(f.to_string());
            }
        }
        out.push(serde_json::Value::Array(
            labels.into_iter().map(serde_json::Value::String).collect(),
        ));
    }
    serde_json::Value::Array(out)
}

/// Answer (or reject) one opencode native question. `rejected` = the user
/// skipped; the tool then returns "dismissed" and the model proceeds.
pub(crate) fn opencode_answer_question(
    base_url: &str,
    oc_session_id: &str,
    request_id: &str,
    rejected: bool,
    answers: &serde_json::Value,
) -> Result<(), String> {
    if base_url.is_empty() || oc_session_id.is_empty() || request_id.is_empty() {
        return Err("missing opencode question routing info".to_string());
    }
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let url = if rejected {
            format!("{base_url}/session/{oc_session_id}/question/{request_id}/reject")
        } else {
            format!("{base_url}/session/{oc_session_id}/question/{request_id}/reply")
        };
        let body = if rejected {
            json!({})
        } else {
            json!({ "answers": answers })
        };
        let resp = client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("question answer post failed: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "question answer HTTP {status}: {}",
                truncate_output(&text)
            ));
        }
        Ok(())
    })
}
