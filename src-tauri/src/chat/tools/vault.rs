//! Vault tools (`vault_list` / `vault_read` / `vault_search` / `vault_write`
//! / `vault_move` / `vault_delete`) — the model's full-CRUD surface onto the
//! bound vault (the Obsidian-like markdown knowledge base, `crate::vault`).
//!
//! Dispatch: NOT through the provider-agnostic `execute_tool` — these need
//! the AppHandle (VaultState root + DbState), exactly like the automations
//! and Session Mesh families. The built-in chat reaches them via
//! `dispatch::run_tool` (which gates the write half behind the permission
//! posture); harness CLIs reach them through the relay-tools MCP bridge
//! (`ALLOWED_RELAY_TOOLS`), which routes to [`execute_vault_tool`] directly.
//! One implementation for both callers, so a wikilink rewrite behaves
//! identically no matter who wrote the note.
//!
//! Every function degrades to a clear instruction when no vault is bound
//! (the tools are advertised always, like `generate_image`).

use serde_json::Value;
use tauri::Manager;

use crate::vault;

/// The read half (always advertised; auto-run in every posture).
pub fn is_vault_tool(name: &str) -> bool {
    matches!(
        name,
        super::VAULT_LIST | super::VAULT_READ | super::VAULT_SEARCH | super::VAULT_WRITE | super::VAULT_MOVE | super::VAULT_DELETE
    )
}

/// The mutating half (schema-stripped under read_only; approval-carded in
/// manual postures like connector writes; plan-mode refused).
pub fn is_vault_write_tool(name: &str) -> bool {
    matches!(name, super::VAULT_WRITE | super::VAULT_MOVE | super::VAULT_DELETE)
}

/// Cap text returned to the model (same convention as fs_read_file).
const VAULT_READ_MAX: usize = 32_000;
const VAULT_LIST_MAX: usize = 200;

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Execute one vault tool call. Returns plain text for the model.
pub async fn execute_vault_tool(app: &tauri::AppHandle, name: &str, args: &Value) -> String {
    // Every branch below does file IO and/or SQLite work: run on the
    // blocking pool, same discipline as the vault_* Tauri commands (the
    // cores scope the DB mutex to their SQL phases internally).
    let app = app.clone();
    let name = name.to_string();
    let args = args.clone();
    match tauri::async_runtime::spawn_blocking(move || execute_vault_tool_sync(&app, &name, &args))
        .await
    {
        Ok(text) => text,
        Err(e) => format!("Error: task join error: {e}"),
    }
}

/// The synchronous body — runs on a blocking thread.
fn execute_vault_tool_sync(app: &tauri::AppHandle, name: &str, args: &Value) -> String {
    let root = match vault::current_root(app) {
        Ok(r) => r,
        Err(e) => return format!("Error: {e}"),
    };
    let db = app.state::<crate::DbState>().inner().0.clone();
    match name {
        super::VAULT_LIST => vault_list(&db, args),
        super::VAULT_READ => vault_read(&db, &root, args),
        super::VAULT_SEARCH => vault_search(&db, args),
        super::VAULT_WRITE => vault_write(&db, &root, args),
        super::VAULT_MOVE => vault_move(&db, &root, args),
        super::VAULT_DELETE => vault_delete(&db, &root, args),
        other => format!("Error: unknown vault tool \"{other}\"."),
    }
}

fn vault_list(db: &parking_lot::Mutex<rusqlite::Connection>, args: &Value) -> String {
    let folder_filter = arg_str(args, "folder")
        .trim_matches('/')
        .to_lowercase();
    let rows: Vec<(String, Option<String>, String, String)> = {
        let conn = db.lock();
        let mut stmt = match conn.prepare(
            "SELECT path, title, basename, aliases FROM vault_files WHERE ext = 'md' ORDER BY path",
        ) {
            Ok(s) => s,
            Err(e) => return format!("Error: vault index unavailable: {e}"),
        };
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        });
        match rows {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(e) => return format!("Error: vault index unavailable: {e}"),
        }
    };
    if rows.is_empty() {
        return "The vault has no notes yet. Create the first one with vault_write.".into();
    }
    let mut lines: Vec<String> = Vec::new();
    let mut total = 0usize;
    for (path, title, basename, aliases_json) in &rows {
        // Case-insensitive: folder names on disk vary in case (Windows).
        if !folder_filter.is_empty()
            && !path.to_lowercase().starts_with(&format!("{folder_filter}/"))
        {
            continue;
        }
        total += 1;
        if lines.len() >= VAULT_LIST_MAX {
            continue;
        }
        let aliases: Vec<String> = serde_json::from_str(aliases_json).unwrap_or_default();
        let alias_note = if aliases.is_empty() {
            String::new()
        } else {
            format!(" (alias: {})", aliases.join(", "))
        };
        let title_note = match title {
            Some(t) if !t.is_empty() && t != basename => format!(" — {t}"),
            _ => String::new(),
        };
        lines.push(format!("{path}{title_note}{alias_note}"));
    }
    if lines.is_empty() {
        return format!("No notes under \"{folder_filter}/\".");
    }
    let mut out = format!("{} note(s) in the vault:\n{}", total, lines.join("\n"));
    if total > VAULT_LIST_MAX {
        out.push_str(&format!("\n… (showing first {VAULT_LIST_MAX})"));
    }
    out
}

fn vault_read(db: &parking_lot::Mutex<rusqlite::Connection>, root: &std::path::Path, args: &Value) -> String {
    let path = arg_str(args, "path");
    if path.is_empty() {
        return "Error: vault_read requires a \"path\" (vault-relative, e.g. \"Notes/Idea.md\").".into();
    }
    match vault::read_note_core(db, root, &path) {
        Ok(text) => {
            if text.len() > VAULT_READ_MAX {
                let mut cut = VAULT_READ_MAX;
                while cut < text.len() && !text.is_char_boundary(cut) {
                    cut += 1;
                }
                format!("{}\n… (truncated at {VAULT_READ_MAX} bytes)", &text[..cut])
            } else {
                text
            }
        }
        Err(e) => format!("Error: {e}"),
    }
}

fn vault_search(db: &parking_lot::Mutex<rusqlite::Connection>, args: &Value) -> String {
    let query = arg_str(args, "query");
    if query.is_empty() {
        return "Error: vault_search requires a \"query\".".into();
    }
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20).clamp(1, 50) as usize;
    let hits = {
        let conn = db.lock();
        vault::index::search(&conn, &query, limit)
    };
    match hits {
        Ok(hits) if hits.is_empty() => format!("No vault notes match \"{query}\".").into(),
        Ok(hits) => {
            let mut out = String::from("Vault search results (path — snippet):\n");
            for h in &hits {
                let snippet = h.snippet.replace('⟨', "").replace('⟩', "");
                let title = h.title.as_deref().unwrap_or(&h.basename);
                out.push_str(&format!("- {} ({}) — {}…\n", h.path, title, snippet.trim()));
            }
            out.push_str(
                "\nOperators: tag:x, path:folder, file:name, \"quoted phrase\", -exclude. \
                 Open a hit with vault_read (path above).",
            );
            out
        }
        Err(e) => format!("Error: vault_search failed: {e:?}"),
    }
}

fn vault_write(db: &parking_lot::Mutex<rusqlite::Connection>, root: &std::path::Path, args: &Value) -> String {
    let path = arg_str(args, "path");
    // The spec marks `content` required, but nothing validates the model's
    // JSON before this point: a missing or NON-STRING content must fail
    // loudly instead of defaulting to "" and blanking an existing note with
    // a success message (an overwrite keeps no recoverable copy — deletes
    // go to .trash, overwrites don't).
    let Some(content) = args.get("content").and_then(|v| v.as_str()) else {
        return "Error: vault_write requires \"content\" as a string — the complete markdown \
                of the note. Omitting it would blank the note."
            .into();
    };
    if path.is_empty() {
        return "Error: vault_write requires \"path\" (vault-relative, must end in .md) and \"content\".".into();
    }
    if !path.to_ascii_lowercase().ends_with(".md") {
        return format!("Error: vault_write paths must end in .md (got \"{path}\").");
    }
    // create-or-overwrite, decided by existence (the model says intent via
    // which tool shape it needs; both land here for identical indexing).
    let exists = vault::safe_join(root, &path)
        .map(|p| p.is_file())
        .unwrap_or(false);
    let result = if exists {
        vault::write_note_core(db, root, &path, content)
    } else {
        vault::create_note_core(db, root, &path, content)
    };
    match result {
        Ok(rel) => {
            let action = if exists { "Overwrote" } else { "Created" };
            let words = content.split_whitespace().count();
            format!(
                "{action} vault note \"{rel}\" ({words} words). Backlinks, search and the \
                 graph update automatically; link [[WikiLinks]] to other notes."
            )
        }
        Err(e) => format!("Error: {e}"),
    }
}

fn vault_move(db: &parking_lot::Mutex<rusqlite::Connection>, root: &std::path::Path, args: &Value) -> String {
    let from = arg_str(args, "from");
    let to = arg_str(args, "to");
    if from.is_empty() || to.is_empty() {
        return "Error: vault_move requires \"from\" and \"to\" (vault-relative .md paths).".into();
    }
    // The spec says notes; enforce it on BOTH sides (rename_note_core only
    // checks `to` — a binary `from` would otherwise rename onto a .md path
    // and index as a garbage note row).
    if !from.to_ascii_lowercase().ends_with(".md") {
        return format!("Error: vault_move \"from\" must end in .md (got \"{from}\").");
    }
    match vault::rename_note_core(db, root, &from, &to) {
        Ok((new_path, rewrites)) => format!(
            "Renamed to \"{new_path}\". {rewrites} note(s) had inbound links rewritten to \
             point at the new location."
        ),
        Err(e) => format!("Error: {e}"),
    }
}

fn vault_delete(db: &parking_lot::Mutex<rusqlite::Connection>, root: &std::path::Path, args: &Value) -> String {
    let path = arg_str(args, "path");
    if path.is_empty() {
        return "Error: vault_delete requires a \"path\".".into();
    }
    if !path.to_ascii_lowercase().ends_with(".md") {
        return format!(
            "Error: vault_delete paths must be .md notes (got \"{path}\"); the trash flow is \
             for notes only."
        );
    }
    match vault::delete_note_core(db, root, &path) {
        Ok(trash_path) => format!(
            "Deleted \"{path}\" (moved to vault .trash: {trash_path}). Inbound links to it \
             are now unresolved."
        ),
        Err(e) => format!("Error: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_classification_splits_read_and_write() {
        assert!(is_vault_tool(super::super::VAULT_LIST));
        assert!(is_vault_tool(super::super::VAULT_READ));
        assert!(is_vault_tool(super::super::VAULT_SEARCH));
        assert!(is_vault_tool(super::super::VAULT_WRITE));
        assert!(is_vault_tool(super::super::VAULT_MOVE));
        assert!(is_vault_tool(super::super::VAULT_DELETE));
        // Write half is exactly the mutating trio.
        assert!(!is_vault_write_tool(super::super::VAULT_LIST));
        assert!(!is_vault_write_tool(super::super::VAULT_READ));
        assert!(!is_vault_write_tool(super::super::VAULT_SEARCH));
        assert!(is_vault_write_tool(super::super::VAULT_WRITE));
        assert!(is_vault_write_tool(super::super::VAULT_MOVE));
        assert!(is_vault_write_tool(super::super::VAULT_DELETE));
        // Not a catch-all.
        assert!(!is_vault_tool("read_file"));
        assert!(!is_vault_write_tool("list_automations"));
    }
}
