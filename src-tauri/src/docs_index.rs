//! Local-docs corpus indexing: Tauri commands + the background index task.
//!
//! Follows the model-download manager pattern (commands/local_model_market.rs):
//! a registry of in-flight index jobs with cancel oneshots, a spawned task,
//! and throttled `docs:index:progress` events.
//!
//! Flow per index run: ensure embedding sidecar → walk + mtime/size diff →
//! drop chunks of vanished files → per changed file: chunk (text) or build a
//! surrogate (image: OCR + optional vision caption) → embed in batches →
//! replace that file's chunks → stamp corpus totals.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use crate::chat::{docs, docs_images, local_models};
use crate::chat::local_models::{LocalModelRegistry, LocalModelState};
use crate::db::{self, docs as docs_db};
use crate::DbState;

pub const PROGRESS_EVENT: &str = "docs:index:progress";

/// Texts per `/embedding` call. llama-server accepts an array; 16 keeps each
/// request small enough to surface failures quickly without per-chunk HTTP
/// overhead dominating.
const EMBED_BATCH: usize = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub corpus_id: String,
    /// "running" | "done" | "cancelled" | "error"
    pub state: String,
    pub processed_files: usize,
    pub total_files: usize,
    pub chunks_written: usize,
    pub images_processed: usize,
    pub images_skipped: usize,
    pub error: Option<String>,
}

impl IndexProgress {
    fn new(corpus_id: &str, state: &str) -> Self {
        Self {
            corpus_id: corpus_id.to_string(),
            state: state.to_string(),
            processed_files: 0,
            total_files: 0,
            chunks_written: 0,
            images_processed: 0,
            images_skipped: 0,
            error: None,
        }
    }
}

/// One slot per corpus currently being indexed. The oneshot fires on cancel.
pub struct IndexSlot {
    pub cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct IndexRegistry {
    pub active: Mutex<HashMap<String, IndexSlot>>,
}

// ---- folder resolution for the embedding model + vision check ----

/// The folders we scan for GGUFs. Mirrors scan_local_models (minus the
/// chat-only default locations): the market dir override, its default, and
/// user-added folders. The Knowledge panel downloads the embedding model into
/// the market dir, so it's always covered.
fn model_scan_dirs(conn: &Connection) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(Some(dir)) = db::get_setting(conn, "local_models.dir") {
        if !dir.trim().is_empty() {
            dirs.push(PathBuf::from(dir));
        }
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("Conduit").join("models"));
    }
    if let Ok(Some(json)) = db::get_setting(conn, "localModels.folders") {
        if let Ok(list) = serde_json::from_str::<Vec<String>>(&json) {
            dirs.extend(
                list.into_iter()
                    .filter(|s| !s.trim().is_empty())
                    .map(PathBuf::from),
            );
        }
    }
    dirs
}

/// Locate an embedding GGUF on disk. scan_folder deliberately hides embedding
/// architectures from the chat picker, so this does its own walk with
/// parse_gguf and picks embedding-arch files, preferring nomic-embed by name.
pub fn find_embedding_gguf(conn: &Connection) -> Option<String> {
    let mut first: Option<String> = None;
    for dir in model_scan_dirs(conn) {
        for entry in walkdir::WalkDir::new(&dir)
            .max_depth(6)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !name.ends_with(".gguf") || name.starts_with("mmproj") {
                continue;
            }
            let meta = local_models::parse_gguf(entry.path());
            if !meta
                .architecture
                .as_deref()
                .is_some_and(local_models::is_embedding_arch)
            {
                continue;
            }
            let path = entry.path().to_string_lossy().to_string();
            if name.contains("nomic-embed") {
                return Some(path);
            }
            if first.is_none() {
                first = Some(path);
            }
        }
    }
    first
}

/// Base URL of a running chat sidecar whose loaded model has vision — used
/// for optional image captions. None when no chat model is running or the
/// running model lacks an mmproj companion.
fn caption_base_url(conn: &Connection, local: &LocalModelRegistry) -> Option<String> {
    let active = local.status()?;
    for dir in model_scan_dirs(conn) {
        for file in local_models::scan_folder(&dir, "user") {
            if file.id == active.model_id {
                return if file.has_vision {
                    Some(active.base_url)
                } else {
                    None
                };
            }
        }
    }
    None
}

// ---- commands ----

type CmdResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsEmbeddingStatus {
    /// Path of the embedding GGUF on disk, if one is installed.
    pub model_path: Option<String>,
    pub running: bool,
    pub base_url: Option<String>,
}

#[tauri::command]
pub fn docs_embedding_status(
    db: State<'_, DbState>,
    local: State<'_, LocalModelState>,
) -> CmdResult<DocsEmbeddingStatus> {
    let model_path = {
        let conn = db.0.lock();
        find_embedding_gguf(&conn)
    };
    let active = local.0.embedding_status();
    Ok(DocsEmbeddingStatus {
        model_path,
        running: active.is_some(),
        base_url: active.map(|a| a.base_url),
    })
}

#[tauri::command]
pub fn docs_add_corpus(
    db: State<'_, DbState>,
    path: String,
    name: Option<String>,
) -> CmdResult<docs_db::DocCorpus> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("folder not readable: {e}"))?
        .to_string_lossy()
        .to_string();
    let name = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            Path::new(&canonical)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| canonical.clone())
        });
    let conn = db.0.lock();
    if let Ok(Some(existing)) = docs_db::get_corpus_by_path(&conn, &canonical) {
        return Err(format!("folder is already indexed as '{}'", existing.name));
    }
    docs_db::add_corpus(&conn, &canonical, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn docs_remove_corpus(db: State<'_, DbState>, corpus_id: String) -> CmdResult<()> {
    let conn = db.0.lock();
    docs_db::remove_corpus(&conn, &corpus_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn docs_list_corpora(db: State<'_, DbState>) -> CmdResult<Vec<docs_db::DocCorpus>> {
    let conn = db.0.lock();
    docs_db::list_corpora(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn docs_set_corpus_enabled(
    db: State<'_, DbState>,
    corpus_id: String,
    enabled: bool,
) -> CmdResult<()> {
    let conn = db.0.lock();
    docs_db::set_corpus_enabled(&conn, &corpus_id, enabled).map_err(|e| e.to_string())
}

/// Pin a corpus to a chat session so its documents are ALWAYS in that chat's
/// auto-retrieval context regardless of query (§3.1.7 per-chat attachment).
#[tauri::command]
pub fn docs_attach_corpus_to_chat(
    db: State<'_, DbState>,
    chat_session_id: String,
    corpus_id: String,
) -> CmdResult<()> {
    let conn = db.0.lock();
    docs_db::attach_corpus_to_chat(&conn, &chat_session_id, &corpus_id).map_err(|e| e.to_string())
}

/// Remove a corpus from a chat's pinned set.
#[tauri::command]
pub fn docs_detach_corpus_from_chat(
    db: State<'_, DbState>,
    chat_session_id: String,
    corpus_id: String,
) -> CmdResult<()> {
    let conn = db.0.lock();
    docs_db::detach_corpus_from_chat(&conn, &chat_session_id, &corpus_id).map_err(|e| e.to_string())
}

/// List the corpus ids pinned to a chat session (empty = none pinned).
#[tauri::command]
pub fn docs_attached_corpus_ids(
    db: State<'_, DbState>,
    chat_session_id: String,
) -> CmdResult<Vec<String>> {
    let conn = db.0.lock();
    docs_db::attached_corpus_ids(&conn, &chat_session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn docs_start_index(
    app: AppHandle,
    db: State<'_, DbState>,
    local: State<'_, LocalModelState>,
    registry: State<'_, Arc<IndexRegistry>>,
    corpus_id: String,
) -> CmdResult<()> {
    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut reg = registry.active.lock();
        // Check + insert under the SAME lock (TOCTOU).
        if reg.contains_key(&corpus_id) {
            return Err("indexing already in progress for this corpus".to_string());
        }
        reg.insert(
            corpus_id.clone(),
            IndexSlot {
                cancel: Some(cancel_tx),
            },
        );
    }

    // Read everything we need up-front; State guards must not cross the spawn.
    let prepared = {
        let conn = db.0.lock();
        let corpus = match docs_db::get_corpus(&conn, &corpus_id) {
            Ok(Some(c)) => c,
            Ok(None) => {
                registry.active.lock().remove(&corpus_id);
                return Err("corpus not found".to_string());
            }
            Err(e) => {
                registry.active.lock().remove(&corpus_id);
                return Err(e.to_string());
            }
        };
        let gguf = if local.0.embedding_status().is_some() {
            None // sidecar already up; no model path needed
        } else {
            match find_embedding_gguf(&conn) {
                Some(p) => Some(p),
                None => {
                    registry.active.lock().remove(&corpus_id);
                    return Err(
                        "no embedding model installed — download one from Settings → Knowledge"
                            .to_string(),
                    );
                }
            }
        };
        let caption_base = caption_base_url(&conn, &local.0);
        (corpus, gguf, caption_base)
    };
    let (corpus, gguf_path, caption_base) = prepared;

    let db_arc = Arc::clone(&db.0);
    let local_arc = Arc::clone(&local.0);
    let registry_arc = Arc::clone(&registry);
    let app_for_task = app.clone();
    let corpus_id_for_task = corpus_id.clone();

    tauri::async_runtime::spawn(async move {
        let progress = run_index(
            &app_for_task,
            &db_arc,
            &local_arc,
            &corpus,
            gguf_path,
            caption_base,
            cancel_rx,
        )
        .await;

        registry_arc.active.lock().remove(&corpus_id_for_task);

        // Refresh the row the UI shows (counts + last_indexed_at).
        if progress.state == "done" || progress.state == "cancelled" {
            let conn = db_arc.lock();
            if let Ok(Some(c)) = docs_db::get_corpus(&conn, &corpus_id_for_task) {
                let _ = app_for_task.emit("docs:corpus:updated", &c);
            }
        }
        let _ = app_for_task.emit(PROGRESS_EVENT, &progress);
    });

    // Let the UI flip to "indexing" immediately.
    let _ = app.emit(PROGRESS_EVENT, IndexProgress::new(&corpus_id, "running"));
    Ok(())
}

#[tauri::command]
pub fn docs_cancel_index(
    registry: State<'_, Arc<IndexRegistry>>,
    corpus_id: String,
) -> CmdResult<bool> {
    let mut reg = registry.active.lock();
    if let Some(slot) = reg.get_mut(&corpus_id) {
        if let Some(tx) = slot.cancel.take() {
            let _ = tx.send(());
            return Ok(true);
        }
    }
    Ok(false)
}

// ---- the index task ----

async fn embed_all(base_url: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let mut out = Vec::with_capacity(texts.len());
    for batch in texts.chunks(EMBED_BATCH) {
        let vecs = local_models::embed_texts(base_url, batch).await?;
        out.extend(vecs);
    }
    Ok(out)
}

async fn run_index(
    app: &AppHandle,
    db: &Arc<Mutex<Connection>>,
    local: &Arc<LocalModelRegistry>,
    corpus: &docs_db::DocCorpus,
    gguf_path: Option<String>,
    caption_base: Option<String>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> IndexProgress {
    let corpus_id = corpus.id.clone();
    let mut progress = IndexProgress::new(&corpus_id, "running");

    macro_rules! finish {
        ($state:expr, $err:expr) => {{
            progress.state = $state.to_string();
            progress.error = $err;
            // Persist whatever we managed to index so the UI + search gate
            // reflect partial progress.
            let conn = db.lock();
            let files = docs_db::list_indexed_files(&conn, &corpus_id)
                .map(|v| v.len() as i64)
                .unwrap_or(0);
            let chunks = docs_db::count_chunks(&conn, &corpus_id).unwrap_or(0);
            let _ = docs_db::finish_index(&conn, &corpus_id, files, chunks);
            return progress;
        }};
    }

    // 1. Ensure the embedding sidecar.
    let base_url = match local.embedding_status() {
        Some(active) => active.base_url,
        None => {
            let gguf = match gguf_path {
                Some(p) => p,
                None => finish!(
                    "error",
                    Some("embedding sidecar not running and no model found".to_string())
                ),
            };
            match local.start_embedding(&gguf).await {
                Ok(started) => started.base_url,
                Err(e) => finish!("error", Some(e)),
            }
        }
    };

    // 2. Walk + diff (blocking-ish, but folder-scale).
    let root = PathBuf::from(&corpus.path);
    let entries = docs::walk_corpus(&root);
    let keep: Vec<String> = entries.iter().map(|e| e.rel_path.clone()).collect();
    let changed: Vec<docs::WalkEntry> = {
        let conn = db.lock();
        let indexed: HashMap<String, (i64, i64)> = docs_db::list_indexed_files(&conn, &corpus_id)
            .unwrap_or_default()
            .into_iter()
            .map(|(p, m, s)| (p, (m, s)))
            .collect();
        if let Err(e) = docs_db::delete_indexed_files_not_in(&conn, &corpus_id, &keep) {
            drop(conn);
            finish!("error", Some(e.to_string()));
        }
        let changed = entries
            .into_iter()
            .filter(|e| indexed.get(&e.rel_path) != Some(&(e.mtime, e.size)))
            .collect::<Vec<_>>();
        drop(conn);
        changed
    };

    progress.total_files = changed.len();
    let _ = app.emit(PROGRESS_EVENT, &progress);
    let mut last_emit = Instant::now() - Duration::from_millis(200);

    // 3. Per-file: build text, embed, store.
    let mut total_chunks: usize = {
        let conn = db.lock();
        docs_db::count_chunks(&conn, &corpus_id).unwrap_or(0) as usize
    };

    for entry in &changed {
        if cancel_rx.try_recv().is_ok() {
            finish!("cancelled", None);
        }
        if total_chunks >= docs::MAX_CHUNKS_PER_CORPUS {
            eprintln!(
                "[docs] corpus '{}' hit the {} chunk cap; remaining files skipped",
                corpus.name,
                docs::MAX_CHUNKS_PER_CORPUS
            );
            break;
        }

        let rel = entry.rel_path.clone();
        let abs = entry.abs_path.clone();

        let built: Option<(String, Vec<String>)> = match entry.kind {
            docs::WalkKind::Text => match std::fs::read_to_string(&abs) {
                Ok(text) => {
                    let mut chunks = docs::chunk_text(&text);
                    let remaining = docs::MAX_CHUNKS_PER_CORPUS - total_chunks;
                    chunks.truncate(remaining);
                    if chunks.is_empty() {
                        // Empty/whitespace file: still record it as indexed so
                        // the diff doesn't reprocess it every run.
                        None
                    } else {
                        Some(("text".to_string(), chunks))
                    }
                }
                Err(e) => {
                    eprintln!("[docs] read failed for {}: {e}", abs.display());
                    None
                }
            },
            docs::WalkKind::Image => {
                let abs_for_ocr = abs.clone();
                let ocr = tokio::task::spawn_blocking(move || docs_images::ocr_image(&abs_for_ocr))
                    .await
                    .ok()
                    .flatten();
                let caption = match &caption_base {
                    Some(base) => docs_images::vision_caption(base, &abs).await,
                    None => None,
                };
                let filename = abs
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| rel.clone());
                match docs_images::compose_surrogate(
                    &filename,
                    ocr.as_deref(),
                    caption.as_deref(),
                ) {
                    Some(surrogate) => {
                        progress.images_processed += 1;
                        Some(("image".to_string(), vec![surrogate]))
                    }
                    None => {
                        progress.images_skipped += 1;
                        // Record it anyway: without a doc_files row the diff
                        // would retry (and re-skip) it on every reindex.
                        let conn = db.lock();
                        let _ = docs_db::upsert_indexed_file(
                            &conn, &corpus_id, &rel, entry.mtime, entry.size,
                        );
                        drop(conn);
                        progress.processed_files += 1;
                        continue;
                    }
                }
            }
        };

        let Some((kind, texts)) = built else {
            // Unreadable/empty file: record so the diff skips it next time.
            let conn = db.lock();
            let _ = docs_db::delete_chunks_for_file(&conn, &corpus_id, &rel);
            let _ = docs_db::upsert_indexed_file(&conn, &corpus_id, &rel, entry.mtime, entry.size);
            drop(conn);
            progress.processed_files += 1;
            continue;
        };

        // A dead sidecar fails every embed from here on — abort the run.
        let vectors = match embed_all(&base_url, &texts).await {
            Ok(v) => v,
            Err(e) => finish!(
                "error",
                Some(format!("embedding failed for {rel}: {e}"))
            ),
        };
        if vectors.len() != texts.len() {
            finish!(
                "error",
                Some(format!(
                    "embedding sidecar returned {} vectors for {} chunks ({rel})",
                    vectors.len(),
                    texts.len()
                ))
            );
        }
        let pairs: Vec<(String, Vec<f32>)> = texts.into_iter().zip(vectors).collect();

        {
            let conn = db.lock();
            if let Err(e) = docs_db::replace_file_chunks(&conn, &corpus_id, &rel, &kind, &pairs) {
                drop(conn);
                finish!("error", Some(e.to_string()));
            }
            let _ = docs_db::upsert_indexed_file(&conn, &corpus_id, &rel, entry.mtime, entry.size);
        }
        total_chunks += pairs.len();
        progress.chunks_written += pairs.len();
        progress.processed_files += 1;

        if last_emit.elapsed().as_millis() >= 150 {
            let _ = app.emit(PROGRESS_EVENT, &progress);
            last_emit = Instant::now();
        }
    }

    finish!("done", None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_scan_dirs_includes_market_default() {
        let conn = crate::db::mem();
        let dirs = model_scan_dirs(&conn);
        // Even with no settings, the ~/Conduit/models default is present.
        if dirs::home_dir().is_some() {
            assert!(dirs.iter().any(|d| d.ends_with("models")));
        }
    }

    #[test]
    fn model_scan_dirs_reads_user_folders_setting() {
        let conn = crate::db::mem();
        crate::db::set_setting(
            &conn,
            "localModels.folders",
            "[\"D:/models-a\", \"\", \"D:/models-b\"]",
        )
        .expect("set setting");
        let dirs = model_scan_dirs(&conn);
        assert!(dirs.contains(&PathBuf::from("D:/models-a")));
        assert!(dirs.contains(&PathBuf::from("D:/models-b")));
        assert!(!dirs.contains(&PathBuf::from("")));
    }

    #[test]
    fn find_embedding_gguf_prefers_nomic_filename() {
        // Build a temp models dir with two fake embedding GGUFs (minimal
        // GGUF headers with an embedding architecture) plus one chat model.
        let tmp = std::env::temp_dir().join(format!("conduit-docs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("mkdir");
        write_fake_gguf(&tmp.join("some-chat-model.gguf"), "llama");
        write_fake_gguf(&tmp.join("bge-small.gguf"), "bert");
        write_fake_gguf(&tmp.join("nomic-embed-text-v1.5.Q8_0.gguf"), "nomic-bert");

        let conn = crate::db::mem();
        crate::db::set_setting(
            &conn,
            "local_models.dir",
            &tmp.to_string_lossy(),
        )
        .expect("set setting");

        let found = find_embedding_gguf(&conn).expect("should find an embedding model");
        assert!(found.contains("nomic-embed"), "got {found}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_embedding_gguf_none_when_only_chat_models() {
        let tmp = std::env::temp_dir().join(format!("conduit-docs-test2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("mkdir");
        write_fake_gguf(&tmp.join("chat.gguf"), "llama");

        let conn = crate::db::mem();
        crate::db::set_setting(&conn, "local_models.dir", &tmp.to_string_lossy())
            .expect("set setting");
        // Point user folders nowhere so a real machine's models can't leak in.
        crate::db::set_setting(&conn, "localModels.folders", "[]").expect("set setting");

        // The market default dir may exist on a dev machine; only assert when
        // it doesn't, otherwise the global nomic preference could match.
        let default = dirs::home_dir().map(|h| h.join("Conduit").join("models"));
        if !default.map(|d| d.exists()).unwrap_or(false) {
            assert_eq!(find_embedding_gguf(&conn), None);
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Minimal valid-enough GGUF: magic + version + metadata KV with
    /// general.architecture. Mirrors what parse_gguf reads.
    fn write_fake_gguf(path: &Path, arch: &str) {
        use std::io::Write;
        let mut buf = Vec::new();
        buf.extend_from_slice(b"GGUF");
        buf.extend_from_slice(&3u32.to_le_bytes()); // version
        buf.extend_from_slice(&0u64.to_le_bytes()); // tensor count
        buf.extend_from_slice(&1u64.to_le_bytes()); // metadata kv count
        let key = b"general.architecture";
        buf.extend_from_slice(&(key.len() as u64).to_le_bytes());
        buf.extend_from_slice(key);
        buf.extend_from_slice(&8u32.to_le_bytes()); // value type: string
        buf.extend_from_slice(&(arch.len() as u64).to_le_bytes());
        buf.extend_from_slice(arch.as_bytes());
        let mut f = std::fs::File::create(path).expect("create");
        f.write_all(&buf).expect("write");
    }
}
