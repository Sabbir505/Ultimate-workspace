//! Extraction phase (design §7): turn a transcript window into scored,
//! evidence-backed candidate memories. The LLM call itself lives in
//! `worker.rs`; this module owns the prompt, the parse, and the cheap
//! deterministic filters (cheap-first, design P3 of the doc pipeline).

use crate::memory::model::MemoryCandidate;

pub const EXTRACTION_SYSTEM: &str = "You maintain long-term memory for a coding assistant. \
From the conversation, extract ONLY durable, reusable facts about the USER or their PROJECT \
that will matter in FUTURE conversations on other topics. \
Include: stable identity facts (name, role, timezone, language); stated preferences and style \
feedback (tools, formats, answer style, corrections of the assistant); durable project facts \
(stack, constraints, decisions, goals); notable ongoing-work state. \
Exclude: transient task details, code bodies or file dumps, anything true only within this \
conversation, secrets/credentials/passwords/API keys, speculation, and anything you invent. \
Each fact MUST be grounded in a verbatim user or assistant quote from the transcript. \
Write each fact as ONE self-contained sentence in third person, timeless tense \
(no \"currently\", no pronouns without antecedents). \
Return ONLY a JSON array, no prose, no code fences: \
[{\"content\":\"...\",\"kind\":\"identity|preference|fact|project|feedback|episode\",\
\"subject\":\"user|project|<topic-slug>\",\"quote\":\"<=40 verbatim words\",\
\"message_ids\":[<ints>],\"importance\":<1-10>,\"importance_rationale\":\"...\"}] \
Rate importance: 1-2 mundane/transient, 3-4 minor convenience, 5-6 shapes how you help \
(preference, project fact), 7-8 high-impact (workflow corrections, core stack, constraints), \
9-10 identity-defining or safety-critical. Never rate 10 unless identity/safety-critical. \
If nothing qualifies, return [].";

/// Render the extraction user message: rolling summary of prior context
/// (Mem0-style) + the new transcript window with message ids for provenance.
pub fn extraction_user_message(rolling_summary: Option<&str>, window: &[(i64, String, String)]) -> String {
    let mut s = String::new();
    if let Some(sum) = rolling_summary.filter(|s| !s.trim().is_empty()) {
        s.push_str("## Prior context summary\n");
        s.push_str(sum.trim());
        s.push_str("\n\n");
    }
    s.push_str("## New messages\n");
    for (id, role, content) in window {
        let who = if role == "user" { "User" } else { "Assistant" };
        // Cap per-message length: extraction needs gist, not file dumps.
        let text = crate::util::truncate_chars(content.trim(), 1500);
        s.push_str(&format!("[msg:{id}] {who}: {text}\n"));
    }
    s.push_str("\nExtract memory candidates as a JSON array now.");
    s
}

/// Parse the extractor's reply into candidates. Tolerates code fences and
/// surrounding prose (small local models add both); drops malformed entries
/// rather than failing the batch.
pub fn parse_candidates(raw: &str) -> Vec<MemoryCandidate> {
    let text = raw.trim();
    let json_body = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .unwrap_or(text);
    let json_body = json_body
        .strip_suffix("```")
        .unwrap_or(json_body)
        .trim();
    // Locate the outermost array when the model pads with prose.
    let start = match json_body.find('[') {
        Some(i) => &json_body[i..],
        None => return Vec::new(),
    };
    let end = match start.rfind(']') {
        Some(i) => &start[..=i],
        None => return Vec::new(),
    };
    serde_json::from_str::<Vec<MemoryCandidate>>(end).unwrap_or_default()
}

/// Deterministic post-extraction filters (design §7.3). Returns the cleaned
/// list plus whether anything was dropped for the audit log.
pub struct FilterReport {
    pub kept: Vec<MemoryCandidate>,
    pub dropped_secrets: usize,
    pub dropped_shape: usize,
}

pub fn filter_candidates(cands: Vec<MemoryCandidate>) -> FilterReport {
    let mut kept = Vec::new();
    let mut dropped_secrets = 0usize;
    let dropped_shape = 0usize;
    for mut c in cands {
        let content = c.content.trim().to_string();
        // Shape: a memory is ONE self-contained sentence-ish fact.
        if content.is_empty()
            || content.len() < 8
            || content.chars().count() > 400
            || content.matches('.').count() > 3
        {
            continue;
        }
        c.content = content;
        // Secrets: prompt rule is defense layer 1, this regex pass is layer 2
        // (design §7.3). Drop the candidate, don't redact — a partially
        // redacted memory is worse than none.
        if looks_like_secret(&c.content) || looks_like_secret(&c.quote) {
            dropped_secrets += 1;
            continue;
        }
        if !crate::memory::model::kind::is_valid(&c.kind) {
            c.kind = "fact".to_string();
        }
        // Importance calibration (design §8.2): clamp into the rubric range.
        c.importance = c.importance.clamp(1, 9);
        kept.push(c);
    }
    FilterReport { kept, dropped_secrets, dropped_shape }
}

/// Token/key-shaped strings never belong in the store. Conservative: high
/// false-positive tolerance is fine (dropping a rare valid sentence costs
/// less than storing a credential).
pub fn looks_like_secret(text: &str) -> bool {
    let t = text.trim();
    const MARKERS: [&str; 14] = [
        "api_key", "apikey", "api-key", "password", "passwd", "secret", "token=", "bearer ",
        "private key", "begin rsa", "begin openssh", "authorization:", "ghp_", "sk-",
    ];
    let lower = t.to_ascii_lowercase();
    if MARKERS.iter().any(|m| lower.contains(m)) {
        return true;
    }
    // Long random-looking alnum runs (>=24 chars incl. mixed case+digits)
    // — typical of pasted credentials.
    let run = t
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|seg| seg.len() >= 24 && seg.chars().any(|c| c.is_ascii_digit()) && seg.chars().any(|c| c.is_ascii_uppercase()) && seg.chars().any(|c| c.is_ascii_lowercase()))
        .count();
    run > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_array() {
        let raw = r#"[{"content":"User prefers pnpm over npm","kind":"preference","subject":"user","quote":"I always use pnpm","message_ids":[3],"importance":6}]"#;
        let cands = parse_candidates(raw);
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].content, "User prefers pnpm over npm");
        assert_eq!(cands[0].message_ids, vec![3]);
    }

    #[test]
    fn parses_fenced_and_prose_padded() {
        let raw = "Here you go:\n```json\n[{\"content\":\"User is in UTC+3\",\"kind\":\"identity\",\"subject\":\"user\",\"quote\":\"I am in UTC+3\",\"message_ids\":[7],\"importance\":5}]\n```\nDone.";
        let cands = parse_candidates(raw);
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].kind, "identity");
    }

    #[test]
    fn garbage_returns_empty_not_panic() {
        assert!(parse_candidates("no json here at all").is_empty());
        assert!(parse_candidates("[{broken").is_empty());
        assert!(parse_candidates("").is_empty());
    }

    #[test]
    fn filter_drops_secrets_and_shapes() {
        let cands = vec![
            MemoryCandidate { content: "User's API key is ghp_abcdefghijklmnop".into(), kind: "fact".into(), subject: "user".into(), quote: String::new(), message_ids: vec![], importance: 5 },
            MemoryCandidate { content: "ok".into(), kind: "fact".into(), subject: "user".into(), quote: String::new(), message_ids: vec![], importance: 5 },
            MemoryCandidate { content: "User prefers concise answers".into(), kind: "preference".into(), subject: "user".into(), quote: "be concise".into(), message_ids: vec![1], importance: 11 },
        ];
        let report = filter_candidates(cands);
        assert_eq!(report.dropped_secrets, 1);
        assert_eq!(report.kept.len(), 1);
        assert_eq!(report.kept[0].content, "User prefers concise answers");
        assert_eq!(report.kept[0].importance, 9); // clamped
    }

    #[test]
    fn secret_detector_shapes() {
        assert!(looks_like_secret("my password hunter2 is great"));
        assert!(looks_like_secret("Authorization: Bearer abc"));
        assert!(looks_like_secret("the key Abcdef123456Abcdef123456 in env"));
        assert!(!looks_like_secret("User prefers tabs for indentation"));
    }

    #[test]
    fn user_message_includes_ids_and_summary() {
        let msg = extraction_user_message(
            Some("Earlier the user set up pnpm."),
            &[(1, "user".into(), "I always use pnpm".into())],
        );
        assert!(msg.contains("Prior context summary"));
        assert!(msg.contains("[msg:1] User:"));
        assert!(msg.contains("JSON array"));
    }
}
