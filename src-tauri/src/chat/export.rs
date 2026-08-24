//! Chat export / import — the local-first backup story (roadmap #7).
//!
//! Exports one chat session or a whole project's chats to a `.zip`, and
//! imports a `.zip` back to restore. Each chat is serialized as a JSON
//! manifest entry (`chats/<slug>/chat.json`) plus its artifact files
//! (`chats/<slug>/artifacts/NNNNNN__name`). A top-level `manifest.json`
//! records scope and version.
//!
//! Cost per chat comes from the message rows themselves (`cost_usd` /
//! `pricing_estimated_usd`); the DB `cost_events` table keys off pty sessions
//! and is unrelated to chatbots, so it is deliberately excluded.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::chat::dispatch;
use crate::db;

/// Schema version this module writes/understands.
pub const EXPORT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatManifest {
    pub version: u32,
    #[serde(rename = "type")]
    pub kind: String, // "chat" | "project"
    pub exported_at: i64,
    pub scope: ManifestScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedChat {
    pub id: String,
    pub title: Option<String>,
    pub provider: String,
    pub model: String,
    pub created_at: i64,
    pub last_active_at: i64,
    pub starred: bool,
    pub unread: bool,
    pub watch_mode: Option<String>,
    pub agent: Option<String>,
    pub project_id: Option<String>,
    pub permission_mode: String,
    pub sandbox_policy: String,
    pub approval_policy: String,
    pub messages: Vec<ExportedMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedMessage {
    /// Original autoincrement id — serialized so import can remap
    /// `superseded_by` references across the renumbering.
    pub id: i64,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub cache_creation_input_tokens: Option<i64>,
    pub cache_read_input_tokens: Option<i64>,
    pub reasoning_output_tokens: Option<i64>,
    pub provider: Option<String>,
    pub model_key: Option<String>,
    pub pricing_estimated_usd: Option<f64>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub llm_time_ms: Option<i64>,
    pub tool_time_ms: Option<i64>,
    pub ttft_ms: Option<i64>,
    pub tokens_per_second: Option<f64>,
    /// Old id this row was folded into (present on compaction summary rows).
    pub superseded_by: Option<i64>,
    pub artifacts: Vec<ExportedArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedArtifact {
    pub filename: String,
    pub kind: String,
}

/// One artifact file read off disk, ready to embed in the zip. `internal_name`
/// (`NNNNNN__name`, zero-padded counter) lexicographically orders the archive
/// entries in the same order `serialize_chat` walked them, so import can map
/// bytes back to messages positionally.
struct ArtifactFile {
    internal_name: String,
    bytes: Vec<u8>,
}

struct ChatWithFiles {
    chat: ExportedChat,
    files: Vec<ArtifactFile>,
}

/// Filesystem-safe folder name from a session title.
pub fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = false;
    for ch in s.chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
            last_dash = false;
        } else if ch.is_whitespace() {
            if !last_dash {
                out.push('-');
                last_dash = true;
            }
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() { "chat".to_string() } else { trimmed }
}

fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Serialize one chat (metadata + messages + artifact bytes) from a live DB
/// connection. Missing/unreadable artifact files are skipped.
fn serialize_chat(
    conn: &Connection,
    session: &crate::types::ChatSession,
) -> Result<ChatWithFiles, String> {
    let messages = db::list_chat_messages(conn, &session.id).map_err(|e| e.to_string())?;
    let arts =
        crate::db::list_artifacts_for_chat(conn, &session.id).map_err(|e| e.to_string())?;
    let by_msg: HashMap<Option<i64>, Vec<&crate::types::ArtifactRecord>> = {
        let mut m: HashMap<Option<i64>, Vec<_>> = HashMap::new();
        for a in &arts {
            m.entry(a.chat_message_id).or_default().push(a);
        }
        m
    };

    let mut exported = Vec::with_capacity(messages.len());
    let mut files: Vec<ArtifactFile> = Vec::new();
    for m in &messages {
        let msg_arts = by_msg.get(&Some(m.id)).cloned().unwrap_or_default();
        let mut exp_arts = Vec::with_capacity(msg_arts.len());
        for a in &msg_arts {
            exp_arts.push(ExportedArtifact {
                filename: a.filename.clone(),
                kind: a.kind.clone(),
            });
            if let Ok(bytes) = std::fs::read(&a.path) {
                files.push(ArtifactFile {
                    internal_name: format!("{:06}__{}", files.len(), sanitize_name(&a.filename)),
                    bytes,
                });
            }
        }
        exported.push(ExportedMessage {
            id: m.id,
            role: m.role.clone(),
            content: m.content.clone(),
            created_at: m.created_at,
            input_tokens: m.input_tokens,
            output_tokens: m.output_tokens,
            cost_usd: m.cost_usd,
            cache_creation_input_tokens: m.cache_creation_input_tokens,
            cache_read_input_tokens: m.cache_read_input_tokens,
            reasoning_output_tokens: m.reasoning_output_tokens,
            provider: m.provider.clone(),
            model_key: m.model_key.clone(),
            pricing_estimated_usd: m.pricing_estimated_usd,
            started_at: m.started_at,
            completed_at: m.completed_at,
            llm_time_ms: m.llm_time_ms,
            tool_time_ms: m.tool_time_ms,
            ttft_ms: m.ttft_ms,
            tokens_per_second: m.tokens_per_second,
            superseded_by: m.superseded_by,
            artifacts: exp_arts,
        });
    }

    Ok(ChatWithFiles {
        chat: ExportedChat {
            id: session.id.clone(),
            title: session.title.clone(),
            provider: session.provider.clone(),
            model: session.model.clone(),
            created_at: session.created_at,
            last_active_at: session.last_active_at,
            starred: session.starred,
            unread: session.unread,
            watch_mode: session.watch_mode.clone(),
            agent: session.agent.clone(),
            project_id: session.project_id.clone(),
            permission_mode: session.permission_mode.clone(),
            sandbox_policy: session.sandbox_policy.clone(),
            approval_policy: session.approval_policy.clone(),
            messages: exported,
        },
        files,
    })
}

/// Materialize a zip archive for a set of chats + manifest → raw bytes.
fn build_zip(manifest: &ChatManifest, chats: &[ChatWithFiles]) -> Result<Vec<u8>, String> {
    use zip::write::SimpleFileOptions;
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let mj = serde_json::to_vec(manifest).map_err(|e| e.to_string())?;
        zip.start_file("manifest.json", opts).map_err(|e| e.to_string())?;
        zip.write_all(&mj).map_err(|e| e.to_string())?;

        for cwf in chats {
            let base = format!(
                "chats/{}/",
                slug(&cwf.chat.title.clone().unwrap_or_else(|| cwf.chat.id.clone()))
            );
            let cj = serde_json::to_vec(&cwf.chat).map_err(|e| e.to_string())?;
            zip.start_file(format!("{base}chat.json"), opts).map_err(|e| e.to_string())?;
            zip.write_all(&cj).map_err(|e| e.to_string())?;
            for f in &cwf.files {
                zip.start_file(format!("{base}artifacts/{}", f.internal_name), opts)
                    .map_err(|e| e.to_string())?;
                zip.write_all(&f.bytes).map_err(|e| e.to_string())?;
            }
        }
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

fn write_zip(dest: PathBuf, zip_bytes: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("could not create dest dir: {e}"))?;
        }
    }
    std::fs::write(&dest, zip_bytes).map_err(|e| format!("could not write zip: {e}"))
}

// ---- Exports (async commands) ----

/// Export a single chat session to a `.zip` at `dest`.
#[tauri::command]
pub async fn export_chat_zip(
    db: tauri::State<'_, crate::DbState>,
    session_id: String,
    dest: String,
) -> Result<(), String> {
    let db = db.0.clone();
    let (_manifest, zip_bytes) = {
        let conn = db.lock();
        let session = crate::db::get_chat_session(&conn, &session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("chat session not found: {session_id}"))?;
        let chat = serialize_chat(&conn, &session)?;
        let manifest = ChatManifest {
            version: EXPORT_VERSION,
            kind: "chat".to_string(),
            exported_at: crate::db::now_ts(),
            scope: ManifestScope {
                session_ids: Some(vec![session_id.clone()]),
                project_id: None,
            },
        };
        let zip_bytes = build_zip(&manifest, std::slice::from_ref(&chat))?;
        (manifest, zip_bytes)
    };
    write_zip(PathBuf::from(&dest), zip_bytes)
}

/// Export every chat bound to a project to a `.zip` at `dest`.
#[tauri::command]
pub async fn export_project_zip(
    db: tauri::State<'_, crate::DbState>,
    project_id: String,
    dest: String,
) -> Result<(), String> {
    let db = db.0.clone();
    let (_manifest, zip_bytes) = {
        let conn = db.lock();
        let all = crate::db::list_chat_sessions(&conn).map_err(|e| e.to_string())?;
        let project_sessions: Vec<_> = all
            .into_iter()
            .filter(|s| s.project_id.as_deref() == Some(project_id.as_str()))
            .collect();
        let mut chats = Vec::with_capacity(project_sessions.len());
        for s in &project_sessions {
            chats.push(serialize_chat(&conn, s)?);
        }
        let manifest = ChatManifest {
            version: EXPORT_VERSION,
            kind: "project".to_string(),
            exported_at: crate::db::now_ts(),
            scope: ManifestScope {
                session_ids: None,
                project_id: Some(project_id.clone()),
            },
        };
        let zip_bytes = build_zip(&manifest, &chats)?;
        (manifest, zip_bytes)
    };
    write_zip(PathBuf::from(&dest), zip_bytes)
}

// ---- Import ----

/// Read one `path` entry back from the archive as bytes.
fn read_zip_entry<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    path: &str,
) -> Result<Vec<u8>, String> {
    match archive.by_name(path) {
        Ok(mut f) => {
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| format!("read {path}: {e}"))?;
            Ok(buf)
        }
        Err(zip::result::ZipError::FileNotFound) => Err(format!("missing entry {path}")),
        Err(e) => Err(format!("zip entry {path}: {e}")),
    }
}

/// Import a chat-export zip, restoring each chat under a fresh session id.
/// Returns the imported session ids.
#[tauri::command]
pub async fn import_chat_zip(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::DbState>,
    src: String,
) -> Result<Vec<String>, String> {
    let artifacts_dir = dispatch::artifacts_dir(&app);
    let bytes = std::fs::read(&src).map_err(|e| format!("could not read zip: {e}"))?;
    let conn = db.0.lock();
    import_zip_bytes(&conn, &bytes, &artifacts_dir)
}

/// Pure import core — testable with an in-memory connection (`db::mem()`).
fn import_zip_bytes(
    conn: &Connection,
    bytes: &[u8],
    artifacts_dir: &std::path::Path,
) -> Result<Vec<String>, String> {
    use std::io::Cursor;

    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("not a zip archive: {e}"))?;

    let mj_raw = read_zip_entry(&mut archive, "manifest.json")?;
    let manifest: ChatManifest =
        serde_json::from_slice(&mj_raw).map_err(|e| format!("bad manifest.json: {e}"))?;
    if manifest.version != EXPORT_VERSION {
        return Err(format!(
            "unsupported export version {} (expected {})",
            manifest.version, EXPORT_VERSION
        ));
    }

    // Collect `chats/<slug>/` dir prefixes (deterministic sort).
    let mut chat_dirs: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let name = match archive.name_for_index(i) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.ends_with("/chat.json") {
            chat_dirs.push(name[..name.len() - "chat.json".len()].to_string());
        }
    }
    chat_dirs.sort();

    let mut imported = Vec::with_capacity(chat_dirs.len());
    for dir in chat_dirs {
        let chat_path = format!("{dir}chat.json");
        let raw = read_zip_entry(&mut archive, &chat_path)?;
        let chat: ExportedChat =
            serde_json::from_slice(&raw).map_err(|e| format!("bad {chat_path}: {e}"))?;

        let new_id = db::new_id();
        let title = chat.title.clone().unwrap_or_else(|| "Imported chat".to_string());
        // Only preserve the project binding if that project actually exists in
        // the target DB — importing into a fresh install can't satisfy the FK
        // otherwise, and silently dropping it keeps content importable.
        let project_id: Option<String> = match &chat.project_id {
            Some(pid) => {
                match conn.query_row(
                    "SELECT 1 FROM projects WHERE id = ?1",
                    rusqlite::params![pid],
                    |_| Ok(()),
                ) {
                    Ok(()) => Some(pid.clone()),
                    Err(_) => None, // project gone on this machine
                }
            }
            None => None,
        };
        conn.execute(
            "INSERT INTO chat_sessions
                (id, title, provider, model, created_at, last_active_at,
                 starred, unread, watch_mode, agent, project_id, permission_mode,
                 sandbox_policy, approval_policy)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            rusqlite::params![
                new_id,
                title,
                chat.provider,
                chat.model,
                chat.created_at,
                chat.last_active_at,
                chat.starred as i64,
                chat.unread as i64,
                chat.watch_mode,
                chat.agent,
                project_id,
                chat.permission_mode,
                chat.sandbox_policy,
                chat.approval_policy,
            ],
        )
        .map_err(|e| format!("insert session: {e}"))?;

        // Insert messages, mapping original id → new autoincrement id.
        let mut old_to_new: HashMap<i64, i64> = HashMap::with_capacity(chat.messages.len());
        for msg in &chat.messages {
            let rec = db::add_chat_message(
                conn,
                &new_id,
                &msg.role,
                &msg.content,
                msg.input_tokens,
                msg.output_tokens,
                msg.cost_usd,
                msg.cache_creation_input_tokens,
                msg.cache_read_input_tokens,
                msg.reasoning_output_tokens,
                msg.provider.as_deref(),
                msg.model_key.as_deref(),
                msg.pricing_estimated_usd,
                msg.started_at,
                msg.completed_at,
                msg.llm_time_ms,
                msg.tool_time_ms,
                msg.ttft_ms,
                msg.tokens_per_second,
            )
            .map_err(|e| format!("insert message: {e}"))?;
            old_to_new.insert(msg.id, rec.id);
        }

        // Patch superseded_by (old id → new id).
        let rows: Vec<(i64, Option<i64>)> = conn
            .prepare("SELECT id, superseded_by FROM chat_messages WHERE chat_session_id = ?1")
            .map_err(|e| e.to_string())?
            .query_map(rusqlite::params![new_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (row_id, old_sup) in rows {
            if let Some(old) = old_sup {
                if let Some(&new_sup) = old_to_new.get(&old) {
                    conn.execute(
                        "UPDATE chat_messages SET superseded_by = ?2 WHERE id = ?1",
                        rusqlite::params![row_id, new_sup],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }

        // Restore artifact files + rows. Archive entries `chats/<slug>/artifacts/*`
        // sort lexicographically (`NNNNNN__name`) in the same order
        // `serialize_chat` pushed bytes per message, so map them back by walking
        // messages' `artifacts` in order and pulling the next entry each time.
        let art_prefix = format!("{dir}artifacts/");
        let mut art_entries: Vec<(String, Vec<u8>)> = Vec::new();
        for i in 0..archive.len() {
            let name = match archive.name_for_index(i) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if name.starts_with(&art_prefix)
                && name.len() > art_prefix.len()
                && !name.ends_with('/')
            {
                if let Ok(bytes) = read_zip_entry(&mut archive, &name) {
                    art_entries.push((name, bytes));
                }
            }
        }
        art_entries.sort_by(|a, b| a.0.cmp(&b.0));

        // Files already present in the artifacts dir, to dedupe on write.
        let mut used = {
            let mut u = std::collections::HashSet::new();
            if let Ok(rd) = std::fs::read_dir(artifacts_dir) {
                for f in rd.flatten() {
                    if let Some(name) = f.file_name().to_str() {
                        u.insert(name.to_string());
                    }
                }
            }
            u
        };

        let mut art_iter = art_entries.into_iter();
        for msg in &chat.messages {
            for exp in &msg.artifacts {
                let Some((_, bytes)) = art_iter.next() else { break };
                // Dedupe filename collisions like the download command does.
                let mut name = sanitize_name(&exp.filename);
                if used.contains(&name) {
                    let (stem, ext) = match name.rsplit_once('.') {
                        Some((s, e)) => (s.to_string(), format!(".{e}")),
                        None => (name.clone(), String::new()),
                    };
                    let mut n = 1;
                    loop {
                        let candidate = format!("{stem} ({n}){ext}");
                        if !used.contains(&candidate) {
                            name = candidate;
                            break;
                        }
                        n += 1;
                    }
                }
                used.insert(name.clone());
                let full = artifacts_dir.join(&name);
                std::fs::write(&full, &bytes)
                    .map_err(|e| format!("write artifact {name}: {e}"))?;
                let art_rec = crate::db::insert_artifact(
                    conn,
                    Some(&new_id),
                    &name,
                    &full.to_string_lossy(),
                    &exp.kind,
                )
                .map_err(|e| format!("insert artifact: {e}"))?;
                // Attribute the just-created row to the (remapped) message.
                if let Some(mid) = old_to_new.get(&msg.id).copied() {
                    conn.execute(
                        "UPDATE artifacts SET chat_message_id = ?2 WHERE id = ?1",
                        rusqlite::params![art_rec.id, mid],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }

        imported.push(new_id);
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn mem() -> Connection {
        db::mem()
    }

    /// Create a chat with 2 messages + 1 artifact file in a temp dir, and
    /// return (conn, chat, tmpdir).
    fn seeded_chat(conn: &Connection) -> (crate::types::ChatSession, std::path::PathBuf) {
        let proj = db::add_project(conn, "/tmp/proj1", "proj-1", true).unwrap();
        let cs = db::create_chat_session(conn, "anthropic", "claude-sonnet-4-5", Some(&proj.id))
            .unwrap();
        db::update_chat_session_title(conn, &cs.id, "My Imported Notes").unwrap();
        // Re-fetch so the returned session carries the updated title.
        let cs = db::get_chat_session(conn, &cs.id).unwrap().unwrap();
        db::add_chat_message(
            conn, &cs.id, "user", "hello",
            None, None, None, None, None, None, None, None, None, None, None, None, None, None, None,
        )
        .unwrap();
        let m2 = db::add_chat_message(
            conn, &cs.id, "assistant", "hi there",
            Some(100), Some(50), Some(0.0015), Some(10), Some(20), Some(5),
            None, None, None, Some(100), Some(130), Some(50), Some(20), Some(15), Some(7.5),
        )
        .unwrap();
        // Create an artifact file in a temp dir so export actually copies bytes.
        let tmp = std::env::temp_dir().join(format!("conduit-export-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let afile = tmp.join("diagram.html");
        std::fs::write(&afile, "<h1>hi</h1>").unwrap();
        db::insert_artifact(conn, Some(&cs.id), "diagram.html", &afile.to_string_lossy(), "html").unwrap();
        // Attach to message m2.
        db::attach_artifacts_to_message(conn, &cs.id, m2.id).unwrap();
        (cs, tmp)
    }

    #[test]
    fn slug_produces_filesystem_safe_names() {
        assert_eq!(slug("My Notes!"), "My-Notes");
        assert!(slug("   ").is_empty() || slug("   ") == "chat");
        assert_eq!(slug("abc_123"), "abc_123");
    }

    #[test]
    fn round_trip_single_chat_preserves_messages_and_artifacts() {
        let conn = mem();
        let (cs, tmp) = seeded_chat(&conn);
        let chat = serialize_chat(&conn, &cs).unwrap();
        let manifest = ChatManifest {
            version: EXPORT_VERSION,
            kind: "chat".to_string(),
            exported_at: db::now_ts(),
            scope: ManifestScope {
                session_ids: Some(vec![cs.id.clone()]),
                project_id: None,
            },
        };
        let zip_bytes = build_zip(&manifest, std::slice::from_ref(&chat)).unwrap();

        // Import into a fresh, empty DB + a FRESH (empty) artifacts dir, so the
        // artifact filename isn't deduped against the source file in `tmp`.
        let conn2 = mem();
        let import_dir =
            std::env::temp_dir().join(format!("conduit-import-roundtrip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&import_dir);
        std::fs::create_dir_all(&import_dir).unwrap();
        let imported = import_zip_bytes(&conn2, &zip_bytes, &import_dir).unwrap();
        assert_eq!(imported.len(), 1);

        let sessions = db::list_chat_sessions(&conn2).unwrap();
        assert_eq!(sessions.len(), 1);
        let new = &sessions[0];
        // New session id != old (import never clobbers).
        assert_ne!(new.id, cs.id);
        assert_eq!(new.title, cs.title);
        assert_eq!(new.provider, "anthropic");
        assert_eq!(new.model, "claude-sonnet-4-5");

        let msgs = db::list_chat_messages(&conn2, &new.id).unwrap();
        assert_eq!(msgs.len(), 2);
        // Message order preserved (user then assistant).
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "hello");
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].content, "hi there");
        assert_eq!(msgs[1].output_tokens, Some(50));
        assert_eq!(msgs[1].started_at, Some(100));
        assert_eq!(msgs[1].completed_at, Some(130));

        // Artifact re-attached to the assistant message.
        let arts = db::list_artifacts_for_chat(&conn2, &new.id).unwrap();
        assert_eq!(arts.len(), 1);
        assert_eq!(arts[0].filename, "diagram.html");
        // Must be attributed to the remapped assistant message id.
        assert_eq!(arts[0].chat_message_id, Some(msgs[1].id));

        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&import_dir);
    }

    #[test]
    fn export_project_serializes_all_bound_chats() {
        let conn = mem();
        let proj1 = db::add_project(&conn, "/tmp/proj1", "proj-1", true).unwrap();
        let proj2 = db::add_project(&conn, "/tmp/proj2", "proj-2", true).unwrap();
        db::create_chat_session(&conn, "openai", "gpt-4o", Some(&proj1.id)).unwrap();
        db::create_chat_session(&conn, "anthropic", "claude-sonnet-4-5", Some(&proj1.id)).unwrap();
        // An unbound + a different-project chat that must be excluded.
        db::create_chat_session(&conn, "openai", "gpt-4o", None).unwrap();
        db::create_chat_session(&conn, "openai", "gpt-4o", Some(&proj2.id)).unwrap();

        let manifest = ChatManifest {
            version: EXPORT_VERSION,
            kind: "project".to_string(),
            exported_at: db::now_ts(),
            scope: ManifestScope { session_ids: None, project_id: Some(proj1.id.clone()) },
        };
        // Simulate what export_project_zip does: filter to proj1.id.
        let all = db::list_chat_sessions(&conn).unwrap();
        let project_sessions: Vec<_> = all
            .iter()
            .filter(|s| s.project_id.as_deref() == Some(proj1.id.as_str()))
            .collect();
        let mut chats = Vec::new();
        for s in &project_sessions {
            chats.push(serialize_chat(&conn, s).unwrap());
        }
        assert_eq!(chats.len(), 2);
        let zip_bytes = build_zip(&manifest, &chats).unwrap();

        // Import into a fresh DB. Imported sessions preserve project_id raw
        // (even though the fresh DB has no such project row — project_id has
        // no FK constraint in chat_sessions).
        let conn2 = mem();
        let tmp = std::env::temp_dir().join(format!("conduit-import-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let imported = import_zip_bytes(&conn2, &zip_bytes, &tmp).unwrap();
        assert_eq!(imported.len(), 2);
        let sessions = db::list_chat_sessions(&conn2).unwrap();
        // Both proj1 chats imported (unbound/proj2 excluded). The fresh import
        // DB has no project row, so the binding is dropped (project_id → NULL)
        // rather than failing the FK.
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().all(|s| s.project_id.is_none()));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn import_rejects_missing_manifest() {
        let conn = mem();
        let tmp = std::env::temp_dir().join(format!("conduit-no-manifest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // A zip with no manifest.json.
        let bytes = {
            use std::io::Write;
            use zip::write::SimpleFileOptions;
            let mut buf = std::io::Cursor::new(Vec::new());
            let mut zip = zip::ZipWriter::new(&mut buf);
            let opts = SimpleFileOptions::default();
            zip.start_file("random.txt", opts).unwrap();
            zip.write_all(b"x").unwrap();
            zip.finish().unwrap();
            buf.into_inner()
        };
        let res = import_zip_bytes(&conn, &bytes, &tmp);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("manifest"));
        // Nothing imported.
        assert_eq!(db::list_chat_sessions(&conn).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn import_rejects_unknown_version() {
        let conn = mem();
        let tmp = std::env::temp_dir().join(format!("conduit-ver-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let manifest = ChatManifest {
            version: 999,
            kind: "chat".to_string(),
            exported_at: 0,
            scope: ManifestScope { session_ids: None, project_id: None },
        };
        let bytes = build_zip(&manifest, &[]).unwrap();
        let res = import_zip_bytes(&conn, &bytes, &tmp);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("unsupported"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
