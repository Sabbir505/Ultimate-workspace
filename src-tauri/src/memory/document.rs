//! The single persistent memory document (design §11 amendment): ONE
//! human-readable field that merges every durable fact, injected as one
//! budgeted block (≤ [`crate::memory::render::DOCUMENT_TOKEN_BUDGET`] tokens).
//!
//! Lifecycle: the extraction pipeline stores facts as records (with full
//! provenance + history), then ONE rewrite call here merges the applied
//! changes into the document — updating superseded details, folding
//! duplicates, organizing under section headers. A rewrite needs an LLM; when
//! none is available the stored document is cleared and the injection falls
//! back to a deterministic render from the records
//! ([`crate::memory::render::build_document_from_records`]), so the document
//! is never stale. UI mutations (add/edit/forget) also clear the stored
//! document for the same reason — the record store is ground truth, and the
//! document is its curated view.

use crate::db;
use rusqlite::Connection;

/// `app_settings` key holding the document text. Empty/absent = no stored
/// document (injection falls back to a deterministic render from records).
pub const SETTING_DOCUMENT: &str = "memory.document";
/// Companion timestamp (unix secs) for the UI's "last updated" line.
pub const SETTING_DOCUMENT_AT: &str = "memory.document.updatedAt";

/// The stored document, if any (trimmed; empty → `None`).
pub fn stored_document(conn: &Connection) -> Option<String> {
    db::get_setting(conn, SETTING_DOCUMENT)
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Persist (Some) or clear (None) the document. Clearing is the "stale"
/// escape hatch: injection falls back to a render from the records. Every
/// non-empty write snapshots a version (bounded history powering the panel's
/// History + Restore); `source` is "merge" (LLM) or "user" (panel save).
pub fn set_document(
    conn: &Connection,
    doc: Option<&str>,
    source: &str,
) -> db::DbResult<()> {
    match doc.map(str::trim).filter(|d| !d.is_empty()) {
        Some(text) => {
            db::set_setting(conn, SETTING_DOCUMENT, text)?;
            db::set_setting(conn, SETTING_DOCUMENT_AT, &crate::db::now_ts().to_string())?;
            db::insert_document_version(conn, source, text)?;
        }
        None => {
            db::set_setting(conn, SETTING_DOCUMENT, "")?;
            db::set_setting(conn, SETTING_DOCUMENT_AT, "")?;
        }
    }
    Ok(())
}

/// System prompt for the rewrite pass. The model sees the current document
/// plus the newly applied changes and returns the FULL merged document.
///
/// Form (user preference, 2026-09-05): ONE compact paragraph of flowing
/// prose — no section headers, no bullets.
///
/// Change labels: `ADD` introduces a new fact; `UPDATED` and `REPLACED` carry
/// BOTH the superseded wording (`was:`) and the current fact (`now:`). A bare
/// `DELETE` + new text used to make rewriters drop the correction itself —
/// the rewriter read "[DELETE] name is Sabbir" and dutifully deleted the new
/// name from the document while the record store was correct. Labels now
/// always state what to remove AND what to keep.
pub const REWRITE_SYSTEM: &str = "You maintain ONE persistent memory document that a personal \
assistant injects about its user. It is ONE compact paragraph of flowing prose: no section \
headers, no bullets, no Markdown structure — one concise timeless sentence per fact, no \
commentary.\n\
You will receive the CURRENT document (the same kind of paragraph) and a list of CHANGES \
already applied to the underlying memory store:\n\
- [ADD] — a brand-new fact; work it into the paragraph as its own sentence.\n\
- [UPDATED] — an existing fact was enriched: replace its old sentence with the `now:` text.\n\
- [REPLACED] — the `was:` fact is NO LONGER TRUE: drop it and make sure the `now:` text is \
present instead.\n\
Rewrite the WHOLE paragraph so it merges the changes: remove superseded sentences, fold \
duplicates into one, keep every other sentence untouched, and keep the prose readable — it \
must read as if written once by a careful human, never as an append log.\n\
HARD LIMIT: the document must stay under ~2200 tokens (~8000 characters). If it would exceed \
that, compact: generalize repeated details, drop the least useful sentences. Never invent facts \
not present in the input. Output ONLY the paragraph text — no fences, no explanations.";

/// One applied store change, rendered for the document rewrite pass.
/// `content` is the fact text AFTER the change; `old_content` is the text it
/// replaced (`None` for a genuinely novel fact). Built from
/// [`crate::memory::consolidate::Applied`].
#[derive(Debug, Clone)]
pub struct DocChange {
    pub op: String,               // store-level op: ADD | UPDATE | DELETE
    pub kind: String,
    pub content: String,
    pub old_content: Option<String>,
}

impl DocChange {
    /// A genuinely new fact (nothing replaced).
    pub fn added(kind: &str, content: &str) -> Self {
        DocChange { op: "ADD".into(), kind: kind.into(), content: content.into(), old_content: None }
    }
}

/// Render the rewrite call's user message: current document + applied changes.
pub fn rewrite_user_message(current: Option<&str>, changes: &[DocChange]) -> String {
    let mut s = String::from("CURRENT document:\n");
    match current.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => s.push_str(d),
        None => s.push_str("(empty — the store has just been seeded; write the first version)"),
    }
    s.push_str("\n\nCHANGES to merge:\n");
    if changes.is_empty() {
        s.push_str("(none)\n");
    }
    for c in changes {
        match c.old_content.as_deref().filter(|o| !o.trim().is_empty()) {
            Some(old) => {
                // The change replaced/merged an existing fact — show both
                // sides so the rewriter removes the stale wording and keeps
                // the current one.
                let label = if c.op == "UPDATE" { "UPDATED" } else { "REPLACED" };
                s.push_str(&format!("- [{label}] ({}) was: {:?} now: {:?}\n", c.kind, old, c.content));
            }
            None => s.push_str(&format!("- [ADD] ({}) {:?}\n", c.kind, c.content)),
        }
    }
    s.push_str("\nReturn the merged document now.");
    s
}

/// Parse the rewritten document: strip optional code fences and prose-style
/// wrappers. Anything that collapses to empty → `None` (caller keeps/clears).
pub fn parse_rewritten(raw: &str) -> Option<String> {
    let text = raw.trim();
    let body = text
        .strip_prefix("```markdown")
        .or_else(|| text.strip_prefix("```md"))
        .or_else(|| text.strip_prefix("```"))
        .unwrap_or(text)
        .trim();
    let body = body.strip_suffix("```").unwrap_or(body).trim();
    // Some models preface with "Here is ..." — the document starts after a
    // short intro line ending in ':' or at its first Markdown header if one
    // exists (older sectioned documents).
    let body = match body.find("\n## ") {
        Some(i) if !body.starts_with('#') => body[i + 1..].trim(),
        _ => body,
    };
    let body = match body.split_once('\n') {
        Some((first, rest))
            if first.trim_end().ends_with(':') && first.len() < 80 && !rest.trim().is_empty() =>
        {
            rest.trim()
        }
        _ => body,
    };
    if body.is_empty() {
        None
    } else {
        Some(body.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_fenced_and_prefixed() {
        assert_eq!(parse_rewritten("# Doc\n- fact"), Some("# Doc\n- fact".into()));
        assert_eq!(
            parse_rewritten("```markdown\n# Doc\n- fact\n```"),
            Some("# Doc\n- fact".into())
        );
        assert_eq!(
            parse_rewritten("Here is the merged document:\n\n## Identity\n- name"),
            Some("## Identity\n- name".into())
        );
        // Prose (paragraph) documents have no headers — the preface rule must
        // still strip a "Here is …:" intro line.
        assert_eq!(
            parse_rewritten("Here is the merged paragraph:\n\nUser's name is Sabbir Hossain."),
            Some("User's name is Sabbir Hossain.".into())
        );
        // A paragraph with no preface passes through untouched.
        assert_eq!(
            parse_rewritten("User's name is Sabbir Hossain. They prefer concise answers."),
            Some("User's name is Sabbir Hossain. They prefer concise answers.".into())
        );
        assert_eq!(parse_rewritten("   "), None);
    }

    #[test]
    fn user_message_lists_changes() {
        let msg = rewrite_user_message(
            Some("# Doc"),
            &[
                DocChange::added("fact", "User uses pnpm"),
                DocChange {
                    op: "DELETE".into(),
                    kind: "identity".into(),
                    content: "User's name is Sabbir Hossain".into(),
                    old_content: Some("User is Arjun Ali".into()),
                },
            ],
        );
        assert!(msg.contains("CURRENT document:"));
        assert!(msg.contains("# Doc"));
        // A brand-new fact renders as an ADD.
        assert!(msg.contains("- [ADD] (fact) \"User uses pnpm\""));
        // A contradiction renders BOTH sides — the old fact to drop and the
        // corrected fact to keep. The old format ("[DELETE] <new text>") made
        // the rewriter delete the correction itself, which is how a name fix
        // erased the name from the document.
        assert!(msg.contains("- [REPLACED] (identity) was: \"User is Arjun Ali\" now: \"User's name is Sabbir Hossain\""));
        assert!(!msg.contains("[DELETE]"));
        // Empty store seeding branch.
        let msg = rewrite_user_message(None, &[]);
        assert!(msg.contains("(empty — the store has just been seeded"));
    }

    #[test]
    fn update_change_renders_was_now() {
        let msg = rewrite_user_message(
            Some("# Doc"),
            &[DocChange {
                op: "UPDATE".into(),
                kind: "fact".into(),
                content: "User likes Rust and dislikes C++ macros".into(),
                old_content: Some("User likes Rust".into()),
            }],
        );
        assert!(msg.contains("- [UPDATED] (fact) was: \"User likes Rust\" now: \"User likes Rust and dislikes C++ macros\""));
    }

    #[test]
    fn empty_old_content_falls_back_to_add() {
        // A DELETE whose target vanished between fetch and apply still must
        // not render as a bare DELETE of the NEW fact.
        let msg = rewrite_user_message(
            Some("# Doc"),
            &[DocChange {
                op: "DELETE".into(),
                kind: "fact".into(),
                content: "User migrated to pnpm".into(),
                old_content: Some("  ".into()),
            }],
        );
        assert!(msg.contains("- [ADD] (fact)"));
        assert!(!msg.contains("REPLACED"));
    }

    #[test]
    fn set_and_clear_document() {
        let conn = crate::db::mem();
        assert!(stored_document(&conn).is_none());
        set_document(&conn, Some("# Doc"), "merge").unwrap();
        assert_eq!(stored_document(&conn).unwrap(), "# Doc");
        set_document(&conn, Some("   "), "user").unwrap(); // whitespace counts as clear
        assert!(stored_document(&conn).is_none());
        set_document(&conn, None, "user").unwrap();
        assert!(stored_document(&conn).is_none());
        // Non-empty writes snapshot versions; clears don't.
        set_document(&conn, Some("# V1"), "merge").unwrap();
        set_document(&conn, Some("# V2"), "user").unwrap();
        let versions = db::list_document_versions(&conn, 10).unwrap();
        assert_eq!(versions.len(), 3); // "# Doc", "# V1", "# V2"
        assert_eq!(versions[0].text, "# V2"); // newest first
        assert_eq!(versions[0].source, "user");
        assert_eq!(versions[1].text, "# V1");
        assert_eq!(versions[2].text, "# Doc");
    }
}
