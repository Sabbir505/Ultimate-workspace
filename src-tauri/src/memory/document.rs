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
pub const REWRITE_SYSTEM: &str = "You maintain ONE persistent memory document that a personal \
assistant injects about its user. It is a compact, human-readable profile in Markdown: short \
section headers (## Identity, ## Preferences, ## Facts, ## Projects, ## Feedback — only the \
ones in use), one concise timeless sentence per fact, no commentary.\n\
You will receive the CURRENT document and a list of CHANGES already applied to the underlying \
memory store (ADD = new fact, UPDATE = fact replaced by a merged version, DELETE = fact \
invalidated by the change). Merge them cleverly: fold each change into the section where it \
belongs, rewrite entries the changes supersede, merge duplicates, drop what a DELETE \
invalidates, and keep everything consistent — the result must read as if written once by a \
careful human, never as an append log.\n\
HARD LIMIT: the document must stay under ~2200 tokens (~8000 characters). If it would exceed \
that, compact: generalize repeated details, drop the least useful entries. Never invent facts \
not present in the input. Output ONLY the document text — no fences, no explanations.";

/// Render the rewrite call's user message: current document + applied changes.
pub fn rewrite_user_message(
    current: Option<&str>,
    changes: &[(String, String, String)], // (op, kind, content)
) -> String {
    let mut s = String::from("CURRENT document:\n");
    match current.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => s.push_str(d),
        None => s.push_str("(empty — the store has just been seeded; write the first version)"),
    }
    s.push_str("\n\nCHANGES to merge:\n");
    if changes.is_empty() {
        s.push_str("(none)\n");
    }
    for (op, kind, content) in changes {
        s.push_str(&format!("- [{op}] ({kind}) {content}\n"));
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
    // Some models preface with "Here is ..." — the document starts at its
    // first header if one exists.
    let body = match body.find("\n## ") {
        Some(i) if !body.starts_with('#') => body[i + 1..].trim(),
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
        assert_eq!(parse_rewritten("   "), None);
    }

    #[test]
    fn user_message_lists_changes() {
        let msg = rewrite_user_message(
            Some("# Doc"),
            &[
                ("ADD".into(), "fact".into(), "User uses pnpm".into()),
                ("DELETE".into(), "preference".into(), "User prefers tabs".into()),
            ],
        );
        assert!(msg.contains("CURRENT document:"));
        assert!(msg.contains("# Doc"));
        assert!(msg.contains("- [ADD] (fact) User uses pnpm"));
        assert!(msg.contains("- [DELETE] (preference) User prefers tabs"));
        // Empty store seeding branch.
        let msg = rewrite_user_message(None, &[]);
        assert!(msg.contains("(empty — the store has just been seeded"));
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
