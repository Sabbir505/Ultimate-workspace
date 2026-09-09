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
Also exclude — these are the common over-captures, not memories: what is being built or \
debugged in THIS conversation, files/paths/commands/branch names touched today, one-off \
questions and their answers, the assistant's own suggestions, and task progress. \
A memory earns its place only if a FUTURE conversation on an unrelated topic would be \
worse off without it. \
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
Anything you would rate below 4 must be OMITTED, not reported low. \
Fewer, better facts beat many; return [] when nothing durable was said.";

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

/// Deterministic importance floor (design §8.2 rubric): 1–3 is mundane /
/// transient / minor — exactly the "writes everything to memory" failure
/// mode. Such candidates never reach the judge (which would ADD them
/// whenever nothing similar exists); dropping them here also saves a judge
/// call each.
pub const IMPORTANCE_WRITE_FLOOR: i64 = 4;

/// Hard cap on candidates one extraction batch may produce, keeping the
/// highest-importance ones. Bounds the judge calls (one per candidate) and
/// stops a chatty transcript from dumping a dozen memories per window.
pub const MAX_CANDIDATES: usize = 5;

/// Deterministic post-extraction filters (design §7.3). Returns the cleaned
/// list plus whether anything was dropped for the audit log.
pub struct FilterReport {
    pub kept: Vec<MemoryCandidate>,
    pub dropped_secrets: usize,
    pub dropped_shape: usize,
    pub dropped_importance: usize,
    pub capped: usize,
}

pub fn filter_candidates(cands: Vec<MemoryCandidate>) -> FilterReport {
    let mut kept = Vec::new();
    let mut dropped_secrets = 0usize;
    let mut dropped_shape = 0usize;
    let mut dropped_importance = 0usize;
    for mut c in cands {
        let content = c.content.trim().to_string();
        // Shape: a memory is ONE self-contained sentence-ish fact.
        if content.is_empty()
            || content.len() < 8
            || content.chars().count() > 400
            || content.matches('.').count() > 3
        {
            dropped_shape += 1;
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
        // Importance calibration (design §8.2): clamp into the rubric range,
        // then enforce the write floor — low-value candidates are dropped,
        // not merely downgraded.
        c.importance = c.importance.clamp(1, 9);
        if c.importance < IMPORTANCE_WRITE_FLOOR {
            dropped_importance += 1;
            continue;
        }
        kept.push(c);
    }
    // Cap the batch, keeping the highest-importance candidates (stable sort
    // preserves transcript order among ties).
    let mut capped = 0usize;
    if kept.len() > MAX_CANDIDATES {
        capped = kept.len() - MAX_CANDIDATES;
        kept.sort_by(|a, b| b.importance.cmp(&a.importance));
        kept.truncate(MAX_CANDIDATES);
    }
    FilterReport { kept, dropped_secrets, dropped_shape, dropped_importance, capped }
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
    fn filter_drops_secrets_shapes_and_low_importance() {
        let cands = vec![
            MemoryCandidate { content: "User's API key is ghp_abcdefghijklmnop".into(), kind: "fact".into(), subject: "user".into(), quote: String::new(), message_ids: vec![], importance: 5 },
            MemoryCandidate { content: "ok".into(), kind: "fact".into(), subject: "user".into(), quote: String::new(), message_ids: vec![], importance: 5 },
            MemoryCandidate { content: "User prefers concise answers".into(), kind: "preference".into(), subject: "user".into(), quote: "be concise".into(), message_ids: vec![1], importance: 11 },
            // Mundane/transient (rubric 1-3): must never reach the judge.
            MemoryCandidate { content: "The user asked about the weather today".into(), kind: "episode".into(), subject: "user".into(), quote: "what's the weather".into(), message_ids: vec![2], importance: 2 },
        ];
        let report = filter_candidates(cands);
        assert_eq!(report.dropped_secrets, 1);
        assert_eq!(report.dropped_shape, 1);
        assert_eq!(report.dropped_importance, 1);
        assert_eq!(report.kept.len(), 1);
        assert_eq!(report.kept[0].content, "User prefers concise answers");
        assert_eq!(report.kept[0].importance, 9); // clamped
    }

    /// The per-batch cap keeps the HIGHEST-importance candidates when the
    /// extractor over-produces — a chatty window must not dump a dozen
    /// memories (each costs a judge call and a document merge).
    #[test]
    fn filter_caps_batch_to_highest_importance() {
        let cands: Vec<MemoryCandidate> = (0..8)
            .map(|i| MemoryCandidate {
                content: format!("Durable fact number {i} about the user"),
                kind: "fact".into(),
                subject: "user".into(),
                quote: "verbatim quote".into(),
                message_ids: vec![i],
                importance: i, // 0..=7 — first ones are below the floor too
            })
            .collect();
        let report = filter_candidates(cands);
        assert_eq!(report.dropped_importance, 4, "importance 0-3 dropped by the floor");
        assert_eq!(report.capped, 0, "below the cap, nothing truncated");
        assert_eq!(report.kept.len(), 4, "only the floor survivors remain");
        assert_eq!(
            report.kept.iter().map(|c| c.importance).collect::<Vec<_>>(),
            vec![4, 5, 6, 7],
            "input order preserved below the cap"
        );

        let cands: Vec<MemoryCandidate> = (4..=9)
            .map(|i| MemoryCandidate {
                content: format!("Durable fact number {i} about the user"),
                kind: "fact".into(),
                subject: "user".into(),
                quote: "verbatim quote".into(),
                message_ids: vec![i],
                importance: i,
            })
            .collect();
        let report = filter_candidates(cands);
        assert_eq!(report.capped, 1);
        assert_eq!(report.kept.len(), MAX_CANDIDATES);
        assert!(report.kept.iter().all(|c| c.importance >= 5), "cap keeps the top of the batch");
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
