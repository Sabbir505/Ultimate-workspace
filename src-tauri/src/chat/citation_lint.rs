//! Citation-integrity lint for research-mode reports.
//!
//! The model writes `[n]` citation markers and a `## Sources` section into
//! its report. Published audits (Tow Center 2025: >60% wrong attribution;
   //! Liu et al. 2023: 74.5% citation precision) show self-reported citations
//! are wrong far too often to trust — but this app's source ledger captured
//! the verbatim evidence, so every check below is mechanical:
//!
//! 1. **Orphan citations** — a `[n]` marker that doesn't resolve to a number
//!    in the report's Sources section, or whose source URL isn't in the
//!    session's ledger (i.e. citing a page that was never read).
//! 2. **Unused ledger rows** — ledger notes that never made it into the
//!    report (coverage gap, or a silently dropped source).
//! 3. **Weak attribution** — the sentence carrying `[n]` shares too little
//!    vocabulary with the cited note's verbatim excerpt (the BBC-audit
//!    "quote absent from the cited article" failure, caught deterministically
//!    via token containment).
//!
//! Zero model calls: this runs as a Rust pass at end of turn, and its JSON
//! verdict reaches the frontend as a `chat:citation-report` event.

use rusqlite::Connection;
use serde::Serialize;

use crate::db;

/// One `[n]` marker the checker could not tie back to the ledger.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Orphan {
    pub number: u32,
    /// Why it is an orphan: number absent from the Sources section, or its
    /// URL missing from the source ledger.
    pub reason: String,
}

/// A cited sentence whose lexical overlap with the cited note's excerpt is
/// suspiciously low.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WeakAttribution {
    pub number: u32,
    /// The sentence that claims something under citation `number`.
    pub sentence: String,
    /// The verbatim excerpt the ledger holds for that source.
    pub excerpt: String,
    /// Containment score 0.0-1.0 (fraction of the sentence's content words
    /// present in the excerpt). Below `WEAK_OVERLAP_THRESHOLD` = flagged.
    pub overlap: f64,
}

/// Full lint verdict for one research report.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CitationReport {
    pub total_citations: usize,
    pub orphan_count: usize,
    pub unused_ledger_count: usize,
    pub uncited_sentences: usize,
    pub weak_count: usize,
    pub orphans: Vec<Orphan>,
    pub unused_urls: Vec<String>,
    pub weak: Vec<WeakAttribution>,
    /// Ledger rows whose notes were all `unavailable` — they SHOULD be unused
    /// (consulted, unreadable), so they are excluded from `unused_urls` and
    /// surfaced here instead.
    pub unavailable_count: usize,
}

/// Overlap below this containment fraction flags a weak attribution. Set
/// deliberately low: a claim and its supporting excerpt usually share the
/// distinctive nouns ("GPU", "contract", dates, names) even when phrased
/// differently; a claim about completely different subject matter than its
/// excerpt scores near zero.
const WEAK_OVERLAP_THRESHOLD: f64 = 0.15;
/// Anchor-token containment below this flags a weak attribution. Anchors are
/// the claim's load-bearing tokens (numbers, dates, names): a genuine claim
/// keeps most of them from its excerpt even when fully reworded, so the bar
/// sits at "at least a third of the anchors present". Applied only when the
/// sentence HAS anchors — otherwise the content-word check covers it.
const WEAK_ANCHOR_THRESHOLD: f64 = 0.34;
/// Sentences shorter than this (content words) carry too little vocabulary
/// for the overlap check to mean anything — skipped, not flagged.
const MIN_SENTENCE_WORDS: usize = 6;

/// A parsed Sources-section entry.
#[derive(Debug, Clone, PartialEq)]
pub struct ReportSource {
    pub number: u32,
    pub url: String,
    pub title: String,
}

/// Parse the LAST `## Sources`-style section of a report into numbered
/// entries. Mirrors `src/lib/chatCitations.ts` (same heading/entry regexes)
/// so the backend lint and the frontend chips always agree on what a source
/// is.
pub fn parse_sources_section(content: &str) -> Vec<ReportSource> {
    let lines: Vec<&str> = content.lines().collect();
    let mut heading_idx: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if is_sources_heading(line.trim()) {
            heading_idx = Some(i);
        }
    }
    let Some(start) = heading_idx else {
        return Vec::new();
    };
    let mut sources = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in &lines[start + 1..] {
        let line = raw.trim();
        if line.starts_with('#') && line.contains(|c: char| !c.is_whitespace()) {
            break; // next markdown heading closes the section
        }
        if line.is_empty() {
            continue;
        }
        let Some((number, body)) = parse_entry_line(line) else {
            continue;
        };
        if !seen.insert(number) {
            continue;
        }
        let Some(url) = extract_url(body) else {
            continue;
        };
        let title = title_from_body(body, &url);
        sources.push(ReportSource {
            number,
            url,
            title,
        });
    }
    sources
}

/// `## Sources`, `**Sources & References**`, `6. Source References:`, … —
/// same tolerance as the frontend parser.
fn is_sources_heading(line: &str) -> bool {
    let s = line
        .trim()
        .trim_start_matches('#')
        .trim()
        .trim_end_matches(':')
        .trim();
    let s = s.trim_matches('*').trim();
    let s = s.trim_end_matches(':').trim();
    // Drop a leading enumeration ("6." / "6)").
    let s = match s.find(|c| c == '.' || c == ')') {
        Some(idx) if idx <= 2 && s[..idx].chars().all(|c| c.is_ascii_digit()) => {
            s[idx + 1..].trim()
        }
        _ => s,
    };
    let lower = s.to_ascii_lowercase();
    let stripped = lower
        .replace("the ", "")
        .replace("references", "")
        .replace("citations", "")
        .replace("list", "")
        .replace("section", "")
        .replace("notes", "")
        .replace("appendix", "")
        .replace('&', " ")
        .replace('/', " ")
        .replace(',', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    stripped == "source" || stripped == "sources"
}

/// One entry line: "1. …", "1) …", "- 1. …", "**[3]** …". Returns
/// `(number, rest-of-line)`.
fn parse_entry_line(line: &str) -> Option<(u32, &str)> {
    let s = line.trim_start_matches(['-', '*', '•', ' ']).trim();
    let s = s.trim_start_matches("**").trim();
    let s = s.strip_prefix('[').unwrap_or(s);
    let digits_end = s.find(|c: char| !c.is_ascii_digit())?;
    if digits_end == 0 || digits_end > 2 {
        return None;
    }
    let number: u32 = s[..digits_end].parse().ok()?;
    let rest = s[digits_end..]
        .trim_start_matches(['.', ')', ']', ':', ' '])
        .trim();
    Some((number, rest))
}

/// First http(s) URL in the entry body, trailing punctuation stripped.
fn extract_url(body: &str) -> Option<String> {
    let idx = body.find("http://").or_else(|| body.find("https://"))?;
    let rest = &body[idx..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == ')' || c == ']' || c == '>')
        .unwrap_or(rest.len());
    Some(rest[..end].trim_end_matches(['.', ',', ';']).to_string())
}

/// Entry label minus URL minus markdown links = the title (or the URL host
/// when the entry was bare).
fn title_from_body(body: &str, url: &str) -> String {
    let no_url = body.replace(url, "");
    let title: String = strip_markdown_links(&no_url)
        .split(|c: char| c == '—' || c == '–' || c == '|' || c == ':')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() {
        url::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
            .unwrap_or_else(|| url.to_string())
    } else {
        title
    }
}

fn strip_markdown_links(s: &str) -> String {
    // "[label](url)" → "label"
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some(close_rel) = s[i..].find(']') {
                let after_close = &s[i + close_rel + 1..];
                let trimmed = after_close.trim_start();
                if trimmed.starts_with('(') {
                    if let Some(paren_rel) = trimmed.find(')') {
                        out.push_str(&s[i + 1..i + close_rel]);
                        i += close_rel + 1 + (after_close.len() - trimmed.len()) + paren_rel + 1;
                        continue;
                    }
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// End-of-turn entry point: lint the turn's research output and persist the
/// verdict. `full_response` is the assistant's final message; `artifact_paths`
/// are the markdown artifacts generated this turn (the report body usually
/// lives there, not in the chat text). Returns `None` when there is nothing
/// to lint — no Sources section anywhere means this wasn't a cited report
/// (everyday answers with zero citations must NOT produce reports).
pub fn lint_and_store(
    conn: &Connection,
    chat_session_id: &str,
    message_id: Option<i64>,
    full_response: &str,
    artifact_paths: &[String],
) -> Option<CitationReport> {
    let mut content = full_response.to_string();
    for path in artifact_paths {
        if let Ok(body) = std::fs::read_to_string(path) {
            content.push_str("\n\n");
            content.push_str(&body);
        }
    }
    if parse_sources_section(&content).is_empty() {
        return None;
    }
    let report = lint_report(conn, chat_session_id, &content);
    let detail = serde_json::to_string(&report).ok()?;
    let _ = db::save_citation_report(
        conn,
        chat_session_id,
        message_id,
        report.total_citations as i64,
        report.orphan_count as i64,
        report.unused_ledger_count as i64,
        report.uncited_sentences as i64,
        report.weak_count as i64,
        &detail,
    );
    Some(report)
}

/// Refine a lint verdict with the async sampler's model judgments (R10):
/// weak flags the verifier rated "supported" are cleared, "unsupported" ones
/// stay flagged, and the refined report is PERSISTED as a new row (the
/// latest-detail query serves it to the Fix action). Returns `None` when the
/// refined report would be identical to the original.
pub fn refine_with_verdicts(
    conn: &Connection,
    chat_session_id: &str,
    message_id: Option<i64>,
    original: &CitationReport,
    verdicts: &[super::citation_verify::VerifyVerdict],
) -> Option<CitationReport> {
    let supported: std::collections::HashSet<u32> = verdicts
        .iter()
        .filter(|v| v.verdict == "supported")
        .map(|v| v.number)
        .collect();
    let weak: Vec<WeakAttribution> = original
        .weak
        .iter()
        .filter(|w| !supported.contains(&w.number))
        .cloned()
        .collect();
    if weak.len() == original.weak.len() {
        return None;
    }
    let refined = CitationReport {
        total_citations: original.total_citations,
        orphan_count: original.orphan_count,
        unused_ledger_count: original.unused_ledger_count,
        uncited_sentences: original.uncited_sentences,
        weak_count: weak.len(),
        orphans: original.orphans.clone(),
        unused_urls: original.unused_urls.clone(),
        weak,
        unavailable_count: original.unavailable_count,
    };
    let mut detail = serde_json::to_string(&refined).ok()?;
    // Mark the row as sampler-refined so trend consumers can tell the passes
    // apart (heuristic-only vs model-verified).
    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&detail) {
        if let Some(obj) = v.as_object_mut() {
            obj.insert("samplerVerified".to_string(), serde_json::Value::Bool(true));
            let cleared: Vec<u32> = supported.into_iter().collect();
            obj.insert(
                "samplerCleared".to_string(),
                serde_json::to_value(cleared).unwrap_or_default(),
            );
        }
        detail = v.to_string();
    }
    let _ = db::save_citation_report(
        conn,
        chat_session_id,
        message_id,
        refined.total_citations as i64,
        refined.orphan_count as i64,
        refined.unused_ledger_count as i64,
        refined.uncited_sentences as i64,
        refined.weak_count as i64,
        &detail,
    );
    Some(refined)
}

/// Run the full lint: report text + the session's ledger. `content` is the
/// final assistant message (or the generated report file body — whichever
/// carries the Sources section; the caller may pass both concatenated).
pub fn lint_report(conn: &Connection, chat_session_id: &str, content: &str) -> CitationReport {
    let sources = parse_sources_section(content);
    let notes = db::list_source_notes(conn, chat_session_id).unwrap_or_default();

    // number → url from the report's own Sources section.
    let mut number_to_url: std::collections::HashMap<u32, String> = std::collections::HashMap::new();
    for s in &sources {
        number_to_url.insert(s.number, s.url.clone());
    }
    // Ledger URLs (normalized) and their best (longest) excerpt.
    let mut ledger: std::collections::HashMap<String, (String, bool)> =
        std::collections::HashMap::new();
    for n in &notes {
        let key = db::canonical_url_key(&n.url);
        let entry = ledger
            .entry(key)
            .or_insert_with(|| (n.excerpt.clone(), n.unavailable.is_some()));
        if n.excerpt.len() > entry.0.len() {
            entry.0 = n.excerpt.clone();
        }
        if entry.1 && n.unavailable.is_none() {
            entry.1 = false;
        }
    }

    // Sentences of the report body (before the Sources section, which is
    // naturally citation-free).
    let body_end = content
        .rfind("\n#")
        .map(|i| i)
        .unwrap_or(content.len());
    let body = &content[..body_end];
    let sentences = split_sentences(body);

    let mut total_citations = 0usize;
    let mut orphans: Vec<Orphan> = Vec::new();
    let mut weak: Vec<WeakAttribution> = Vec::new();
    let mut uncited_sentences = 0usize;
    // URLs actually cited via markers (canonical keys).
    let mut cited_keys: std::collections::HashSet<String> = std::collections::HashSet::new();

    for sentence in &sentences {
        // Inline-code spans (`arr[0]`) are source text, not citations — same
        // protection the frontend applies before rewriting chips.
        let code_stripped = strip_inline_code(sentence);
        let markers = extract_citation_numbers(&code_stripped);
        if markers.is_empty() {
            if count_content_words(sentence) >= MIN_SENTENCE_WORDS {
                uncited_sentences += 1;
            }
            continue;
        }
        total_citations += markers.len();
        let sentence_key = sentence_key(sentence);
        let anchor_key = anchor_key(sentence);
        for n in markers {
            let Some(url) = number_to_url.get(&n) else {
                orphans.push(Orphan {
                    number: n,
                    reason: "number not present in the report's Sources section".to_string(),
                });
                continue;
            };
            let key = db::canonical_url_key(url);
            let Some((excerpt, unavailable)) = ledger.get(&key) else {
                orphans.push(Orphan {
                    number: n,
                    reason: format!("source {url} not found in the session's source ledger"),
                });
                continue;
            };
            cited_keys.insert(key);
            if *unavailable {
                // Citing a source known to be unreadable — treat as orphan
                // (the note carries no usable excerpt to attribute to).
                orphans.push(Orphan {
                    number: n,
                    reason: format!("source {url} was recorded as unavailable (unreadable)"),
                });
                continue;
            }
            // Attribution check, two tiers: when the claim carries ANCHOR
            // tokens (numbers, dates, capitalized names — the load-bearing
            // parts of a factual claim), containment is measured over those
            // only; all-content-word containment floods a synthesized report
            // with false "weak" flags because good writing deliberately
            // rewords. Sentences without anchors (fully paraphrased prose)
            // fall back to the low-threshold content-word check, which only
            // flags claims about an entirely different subject.
            let anchor_overlap = containment(&anchor_key, excerpt);
            let overlap = if !anchor_key.is_empty() {
                if anchor_overlap >= WEAK_ANCHOR_THRESHOLD {
                    // Anchored claim supported — don't re-test with the
                    // stricter full-vocabulary metric.
                    anchor_overlap
                } else {
                    anchor_overlap
                }
            } else {
                containment(&sentence_key, excerpt)
            };
            let flagged = if !anchor_key.is_empty() {
                anchor_overlap < WEAK_ANCHOR_THRESHOLD
            } else {
                overlap < WEAK_OVERLAP_THRESHOLD
            };
            if flagged {
                weak.push(WeakAttribution {
                    number: n,
                    sentence: sentence.trim().to_string(),
                    excerpt: excerpt.trim().to_string(),
                    overlap,
                });
            }
        }
    }

    // Ledger rows never cited. Unavailable notes are expected-uncited.
    let mut unused_urls: Vec<String> = Vec::new();
    let mut unavailable_count = 0usize;
    for n in &notes {
        let key = db::canonical_url_key(&n.url);
        if n.unavailable.is_some() {
            unavailable_count += 1;
            continue;
        }
        if !cited_keys.contains(&key) && !unused_urls.contains(&n.url) {
            unused_urls.push(n.url.clone());
        }
    }

    CitationReport {
        total_citations,
        orphan_count: orphans.len(),
        unused_ledger_count: unused_urls.len(),
        uncited_sentences,
        weak_count: weak.len(),
        orphans,
        unused_urls,
        weak,
        unavailable_count,
    }
}

/// Replace `` `…` `` inline-code spans with spaces (preserving offsets) so
/// bracketed numbers inside code never read as citations.
fn strip_inline_code(s: &str) -> String {
    let mut out: Vec<char> = Vec::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '`' {
            if let Some(close) = chars[i + 1..].iter().position(|&c| c == '`') {
                out.push(' ');
                out.extend(std::iter::repeat(' ').take(close));
                i += close + 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out.into_iter().collect()
}

/// Citation markers in one sentence: `[3]`, `[3, 7]`, `[3][7]`, `(3, 7)`.
/// Bracketed singles count (unambiguous); parenthesized singles do NOT —
/// "(3)" in prose is far more often an enumeration than a citation, matching
/// the frontend's rule that paren style requires at least two numbers.
fn extract_citation_numbers(sentence: &str) -> Vec<u32> {
    let bytes = sentence.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = sentence[i..].chars().next().unwrap();
        if c == '[' || c == '(' {
            let close = if c == '[' { ']' } else { ')' };
            if let Some(end_rel) = sentence[i + 1..].find(close) {
                let inner = &sentence[i + 1..i + 1 + end_rel];
                if inner.chars().all(|ch| ch.is_ascii_digit() || ch == ',' || ch == ' ')
                    && inner.contains(|ch: char| ch.is_ascii_digit())
                {
                    let numbers: Vec<u32> = inner
                        .split(',')
                        .filter_map(|p| p.trim().parse::<u32>().ok())
                        .filter(|n| *n > 0)
                        .collect();
                    // Paren markers need ≥2 numbers to count as citations.
                    let is_citation = c == '[' || numbers.len() >= 2;
                    if is_citation {
                        for n in numbers {
                            if !out.contains(&n) {
                                out.push(n);
                            }
                        }
                    }
                    i += end_rel + 2;
                    continue;
                }
            }
        }
        i += c.len_utf8();
    }
    out
}

/// Split into rough sentences: on `.`, `!`, `?` followed by whitespace/upper,
/// and on newlines. Bullet/table rows count as sentence units — they carry
/// claims too.
fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for para in text.split('\n') {
        let para = para.trim();
        if para.is_empty() || para.starts_with('#') {
            continue;
        }
        let mut current = String::new();
        let mut prev: Option<char> = None;
        for c in para.chars() {
            current.push(c);
            let ends = matches!(c, '.' | '!' | '?')
                && prev.is_some_and(|p| !p.is_whitespace())
                && c != '.';
            let _ = ends;
            if matches!(c, '.' | '!' | '?') {
                // Boundary unless part of a number/abbreviation-ish pattern:
                // digit.digit ("3.5"), single letter ("e.g") — heuristic.
                let trimmed = current.trim_end();
                let before = trimmed.chars().rev().nth(1);
                let looks_decimal = matches!(before, Some(d) if d.is_ascii_digit())
                    && trimmed.len() >= 2
                    && trimmed
                        .chars()
                        .rev()
                        .nth(2)
                        .is_some_and(|d| d.is_ascii_digit());
                if !looks_decimal {
                    let s = current.trim();
                    if !s.is_empty() {
                        out.push(s.to_string());
                    }
                    current.clear();
                }
            }
            prev = Some(c);
        }
        let rest = current.trim();
        if !rest.is_empty() {
            out.push(rest.to_string());
        }
    }
    out
}

/// Lowercased content words (letters/digits only), stopwords dropped, ≥3 chars.
fn sentence_key(s: &str) -> Vec<String> {
    s.to_ascii_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 3 && !STOPWORDS.contains(w))
        .map(str::to_string)
        .collect()
}

/// A sentence's ANCHOR tokens: the parts a factual claim cannot fake —
/// numbers/quantities (90B, 2026, 37%) and capitalized non-initial words
/// (names like "Rust", "Fowler", months like "September"). A synthesized
/// claim legitimately rewords everything else; losing or inventing anchors
/// is what misattribution looks like. Lowercased for comparison.
fn anchor_key(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut prev_word_capitalized = false;
    for (idx, word) in s.split(|c: char| !c.is_alphanumeric()).enumerate() {
        if word.is_empty() {
            continue;
        }
        let has_digit = word.chars().any(|c| c.is_ascii_digit());
        if has_digit {
            let w = word.to_ascii_lowercase();
            if !out.contains(&w) {
                out.push(w);
            }
            prev_word_capitalized = false;
            continue;
        }
        let starts_upper = word.chars().next().is_some_and(|c| c.is_uppercase());
        // A capitalized word that is NOT the sentence's first token and does
        // not continue an all-caps run (acronyms after a capitalized word)
        // is treated as a proper noun / month / name.
        let proper = starts_upper && idx > 0 && !prev_word_capitalized;
        prev_word_capitalized = starts_upper;
        if proper && word.len() >= 3 {
            let w = word.to_ascii_lowercase();
            if !out.contains(&w) {
                out.push(w);
            }
        }
    }
    out
}

fn count_content_words(s: &str) -> usize {
    sentence_key(s).len()
}

/// Fraction of `sentence`'s content words that appear in `excerpt`'s word set.
fn containment(sentence_words: &[String], excerpt: &str) -> f64 {
    if sentence_words.is_empty() {
        return 1.0;
    }
    let excerpt_words = sentence_key(excerpt);
    let excerpt_set: std::collections::HashSet<&str> =
        excerpt_words.iter().map(String::as_str).collect();
    let hits = sentence_words
        .iter()
        .filter(|w| excerpt_set.contains(w.as_str()))
        .count();
    hits as f64 / sentence_words.len() as f64
}

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "was", "were", "are", "has", "have",
    "had", "its", "their", "they", "them", "than", "then", "into", "over", "under", "about",
    "after", "before", "between", "which", "while", "will", "would", "could", "should", "been",
    "being", "also", "more", "most", "some", "such", "only", "when", "where", "who", "whom",
    "whose", "what", "how", "why", "not", "but", "all", "any", "each", "both", "few", "other",
    "per", "via", "one", "two", "three", "his", "her", "him", "she", "you", "your", "our",
];

#[cfg(test)]
mod tests {
    use super::*;

    const REPORT: &str = r#"# Report

Rust 1.90 shipped in September 2026 [1]. The compiler now ships with an
async closure feature [2]. Nothing else happened. See [9] for details.

## Sources

1. Rust Blog — https://blog.rust-lang.org/2026/09/01/rust-1.90/
2. The Rust Book — https://doc.rust-lang.org/book/
"#;

    #[test]
    fn parse_sources_section_finds_numbered_entries() {
        let sources = parse_sources_section(REPORT);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].number, 1);
        assert_eq!(
            sources[0].url,
            "https://blog.rust-lang.org/2026/09/01/rust-1.90/"
        );
        assert_eq!(sources[0].title, "Rust Blog");
        assert_eq!(sources[1].number, 2);
        assert_eq!(sources[1].url, "https://doc.rust-lang.org/book/");
        assert_eq!(sources[1].title, "The Rust Book");
    }

    #[test]
    fn parse_sources_tolerates_decorations() {
        let md = "**Source References:**\n\n- [1] [A Page](https://a.example/x) — note\n";
        let sources = parse_sources_section(md);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].number, 1);
        assert_eq!(sources[0].url, "https://a.example/x");
        assert_eq!(sources[0].title, "A Page");
        // No sources section → empty.
        assert!(parse_sources_section("Just prose [1] with no section.").is_empty());
    }

    #[test]
    fn extract_citation_numbers_handles_all_marker_styles() {
        assert_eq!(extract_citation_numbers("a [3] b"), vec![3]);
        assert_eq!(extract_citation_numbers("a [3, 7] b"), vec![3, 7]);
        assert_eq!(extract_citation_numbers("a [3][7] b"), vec![3, 7]);
        assert_eq!(extract_citation_numbers("a (3,7) b"), vec![3, 7]);
        // Non-citations stay untouched.
        assert!(extract_citation_numbers("step (3) of the algorithm").is_empty());
        assert!(extract_citation_numbers("see [note] here").is_empty());
        // Code spans are stripped by the caller before extraction.
        assert!(extract_citation_numbers(&strip_inline_code("the `array[42]` index")).is_empty());
        // Bare [42] outside code IS treated as a citation marker (same as the
        // frontend chips) — a documented tradeoff, not silently hidden.
        assert_eq!(extract_citation_numbers("array[42] index"), vec![42]);
    }

    #[test]
    fn lint_flags_orphan_and_unavailable_citations() {
        let conn = crate::db::mem();
        let cs = crate::db::create_chat_session(&conn, "anthropic", "claude-sonnet-5", None)
            .unwrap();
        crate::db::add_source_note(
            &conn,
            &cs.id,
            "https://blog.rust-lang.org/2026/09/01/rust-1.90/",
            "Rust Blog",
            "Rust 1.90 shipped in September 2026.",
            "Rust 1.90 shipped in September 2026.",
            None,
            Some("Rust Blog"),
            Some("2026-09-01"),
        )
        .unwrap();
        // Sources 2 (never in the ledger) and 9 (no Sources entry) are both
        // orphans; source 1 resolves.
        let report = lint_report(&conn, &cs.id, REPORT);
        assert_eq!(report.orphan_count, 2, "{report:?}");
        assert_eq!(report.total_citations, 3);
        let orphan_numbers: Vec<u32> = report.orphans.iter().map(|o| o.number).collect();
        assert!(orphan_numbers.contains(&2));
        assert!(orphan_numbers.contains(&9));
        assert!(report.orphans.iter().any(|o| o.reason.contains("ledger")));
    }

    #[test]
    fn lint_counts_unused_ledger_rows_and_skips_unavailable() {
        let conn = crate::db::mem();
        let cs = crate::db::create_chat_session(&conn, "anthropic", "claude-sonnet-5", None)
            .unwrap();
        crate::db::add_source_note(
            &conn,
            &cs.id,
            "https://blog.rust-lang.org/2026/09/01/rust-1.90/",
            "Rust Blog",
            "Rust 1.90 shipped in September 2026.",
            "Rust 1.90 shipped in September 2026.",
            None,
            Some("Rust Blog"),
            Some("2026-09-01"),
        )
        .unwrap();
        // Unreadable source: expected NOT to appear in the report.
        crate::db::add_source_note(
            &conn,
            &cs.id,
            "https://paywalled.example/article",
            "Paywalled",
            "n/a",
            "",
            Some("paywalled"),
            None,
            None,
        )
        .unwrap();
        // Readable but uncited source: flagged unused.
        crate::db::add_source_note(
            &conn,
            &cs.id,
            "https://unused.example/page",
            "Unused",
            "A fact nobody cited.",
            "A fact nobody cited.",
            None,
            None,
            None,
        )
        .unwrap();
        let report = lint_report(&conn, &cs.id, REPORT);
        assert_eq!(report.unavailable_count, 1);
        assert_eq!(report.unused_ledger_count, 1);
        assert_eq!(report.unused_urls, vec!["https://unused.example/page"]);
    }

    #[test]
    fn lint_flags_weak_attribution_for_unrelated_claim() {
        let conn = crate::db::mem();
        let cs = crate::db::create_chat_session(&conn, "anthropic", "claude-sonnet-5", None)
            .unwrap();
        crate::db::add_source_note(
            &conn,
            &cs.id,
            "https://blog.rust-lang.org/2026/09/01/rust-1.90/",
            "Rust Blog",
            "Rust 1.90 released September 2026.",
            "Rust 1.90 released September 2026 with async closures stabilized.",
            None,
            None,
            None,
        )
        .unwrap();
        let report = format!(
            "# Report\n\nRust 1.90 shipped in September 2026 [1].\n\n\
             The quarterly pineapple harvest doubled this year [1].\n\n\
             ## Sources\n\n1. Rust Blog — https://blog.rust-lang.org/2026/09/01/rust-1.90/\n"
        );
        let linted = lint_report(&conn, &cs.id, &report);
        assert_eq!(linted.orphan_count, 0);
        assert_eq!(linted.weak_count, 1, "{linted:?}");
        assert!(linted.weak[0].sentence.contains("pineapple"));
        assert!(linted.weak[0].overlap < WEAK_OVERLAP_THRESHOLD);
    }

    #[test]
    fn lint_passes_well_attributed_report() {
        let conn = crate::db::mem();
        let cs = crate::db::create_chat_session(&conn, "anthropic", "claude-sonnet-5", None)
            .unwrap();
        crate::db::add_source_note(
            &conn,
            &cs.id,
            "https://blog.rust-lang.org/2026/09/01/rust-1.90/",
            "Rust Blog",
            "Rust 1.90 shipped in September 2026 with async closures.",
            "\"Rust 1.90 shipped in September 2026 with async closures stabilized.\"",
            None,
            None,
            None,
        )
        .unwrap();
        let report = format!(
            "# Report\n\nRust 1.90 shipped in September 2026 with async closures [1].\n\n\
             ## Sources\n\n1. Rust Blog — https://blog.rust-lang.org/2026/09/01/rust-1.90/\n"
        );
        let linted = lint_report(&conn, &cs.id, &report);
        assert_eq!(linted.orphan_count, 0, "{linted:?}");
        assert_eq!(linted.weak_count, 0, "{linted:?}");
        assert_eq!(linted.total_citations, 1);
        assert_eq!(linted.unused_ledger_count, 0);
    }

    #[test]
    fn lint_passes_reworded_claim_with_matching_anchors() {
        // A fully reworded claim keeps its anchors (Rust, 2026) — the
        // all-words heuristic flagged this shape as "weak" (44/63 on a real
        // report); the anchor tier must pass it.
        let conn = crate::db::mem();
        let cs = crate::db::create_chat_session(&conn, "anthropic", "claude-sonnet-5", None)
            .unwrap();
        crate::db::add_source_note(
            &conn,
            &cs.id,
            "https://blog.rust-lang.org/2026/09/01/rust-1.90/",
            "Rust Blog",
            "Rust 1.90 released September 2026.",
            "Rust 1.90 released September 2026 with async closures stabilized.",
            None,
            None,
            None,
        )
        .unwrap();
        let report = format!(
            "# Report\n\nThe latest Rust update brought stable async closures in late 2026 [1].\n\n\
             ## Sources\n\n1. Rust Blog — https://blog.rust-lang.org/2026/09/01/rust-1.90/\n"
        );
        let linted = lint_report(&conn, &cs.id, &report);
        assert_eq!(linted.weak_count, 0, "{linted:?}");
    }

    #[test]
    fn lint_and_store_persists_and_reads_artifact_files() {
        let conn = crate::db::mem();
        let cs = crate::db::create_chat_session(&conn, "anthropic", "claude-sonnet-5", None)
            .unwrap();
        crate::db::add_source_note(
            &conn,
            &cs.id,
            "https://blog.rust-lang.org/2026/09/01/rust-1.90/",
            "Rust Blog",
            "Rust 1.90 shipped in September 2026.",
            "Rust 1.90 shipped in September 2026.",
            None,
            None,
            None,
        )
        .unwrap();
        // The report body usually lives in a generated artifact file, not the
        // chat text — lint_and_store must read it.
        let dir = std::env::temp_dir().join(format!("conduit-lint-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let artifact = dir.join("report.md");
        std::fs::write(
            &artifact,
            "# Report\n\nRust 1.90 shipped in September 2026 [1]. Also [7] says so.\n\n\
             ## Sources\n\n1. Rust Blog — https://blog.rust-lang.org/2026/09/01/rust-1.90/\n",
        )
        .unwrap();
        let verdict = lint_and_store(
            &conn,
            &cs.id,
            Some(42),
            "The report is attached.", // chat text has no Sources section
            &[artifact.to_string_lossy().into_owned()],
        )
        .expect("report should lint");
        assert_eq!(verdict.total_citations, 2);
        assert_eq!(verdict.orphan_count, 1, "{verdict:?}");
        // Stored for trend tracking.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM citation_reports", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let (total, mid): (i64, Option<i64>) = conn
            .query_row(
                "SELECT total_citations, message_id FROM citation_reports LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((total, mid), (2, Some(42)));
        std::fs::remove_dir_all(&dir).ok();

        // No Sources section anywhere → None (everyday answers don't lint).
        assert!(lint_and_store(&conn, &cs.id, None, "Just 2+2 = 4.", &[]).is_none());
    }
}
