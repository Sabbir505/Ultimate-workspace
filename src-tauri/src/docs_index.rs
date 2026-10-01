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
use tauri::{AppHandle, Emitter, Manager, State};
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

/// Char budget for the one retry after a failed batch embed (see the
/// `run_index` embed arm): heads of the enriched texts, sized to fit
/// sidecars running llama-server's DEFAULT 512-token physical batch —
/// ~450 tokens worst case on prose (≈4 chars/token), while CJK content
/// (~1 token/char) still fits our own sidecar's 2048 context.
const EMBED_RETRY_CHAR_CAP: usize = 1800;

#[cfg(test)]
mod retry_budget_tests {
    use super::*;

    /// The retry budget must keep the enrichment HEAD (path · heading leads
    /// the embed text and anchors retrieval) and cut only the content tail.
    #[test]
    fn retry_head_keeps_the_enrichment_prefix() {
        let text = format!(
            "4H-1H-Trading-Algo/AI_CONTEXT.md · Strategy > Context\n\n{}",
            "x".repeat(5000)
        );
        let shrunk: String = text.chars().take(EMBED_RETRY_CHAR_CAP).collect();
        assert_eq!(shrunk.chars().count(), EMBED_RETRY_CHAR_CAP);
        assert!(shrunk.starts_with("4H-1H-Trading-Algo/AI_CONTEXT.md · Strategy"));
        // Multibyte-safe: no replacement chars from a byte-slice cut.
        let cjk = format!("a.md · 标题\n\n{}", "内容".repeat(2000));
        let shrunk_cjk: String = cjk.chars().take(EMBED_RETRY_CHAR_CAP).collect();
        assert_eq!(shrunk_cjk.chars().count(), EMBED_RETRY_CHAR_CAP);
        assert!(!shrunk_cjk.contains('\u{FFFD}'));
    }

    /// Short texts pass through the budget untouched (no needless re-slice).
    #[test]
    fn retry_budget_leaves_short_texts_whole() {
        let text = "a.md · Heading\n\nshort body".to_string();
        let shrunk: String = text.chars().take(EMBED_RETRY_CHAR_CAP).collect();
        assert_eq!(shrunk, text);
    }
}

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
/// the market dir, so it's always covered. Also walked by
/// `local_models::find_reranker_gguf` for the reranker sidecar's model.
pub(crate) fn model_scan_dirs(conn: &Connection) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(Some(dir)) = db::get_setting(conn, "local_models.dir") {
        if !dir.trim().is_empty() {
            dirs.push(PathBuf::from(dir));
        }
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(crate::user_dirs::default_models_dir(&home));
        // Pre-rebrand layout: keep indexing ~/Conduit/models when it exists.
        let legacy = home.join("Conduit").join("models");
        if legacy.exists() && !dirs.contains(&legacy) {
            dirs.push(legacy);
        }
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
            // "reranker"-named GGUFs (bge-reranker-*) are cross-encoders
            // served with --reranking; their header carries an embedding arch
            // (xlm-roberta) but they cannot produce corpus embeddings — keep
            // them out of the embedder pick (find_reranker_gguf owns them).
            if !name.ends_with(".gguf") || name.starts_with("mmproj") || name.contains("reranker") {
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
    /// Reranker sidecar status (the optional `docs.rerank` second-stage
    /// ranking for `search_docs`).
    pub reranker: RerankerStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RerankerStatus {
    /// Path of the reranker GGUF on disk, if one is installed.
    pub model_path: Option<String>,
    pub running: bool,
    pub base_url: Option<String>,
}

#[tauri::command(async)]
pub fn docs_embedding_status(
    db: State<'_, DbState>,
    local: State<'_, LocalModelState>,
) -> CmdResult<DocsEmbeddingStatus> {
    let (model_path, reranker_path) = {
        let conn = db.0.lock();
        (
            find_embedding_gguf(&conn),
            local_models::find_reranker_gguf(&conn),
        )
    };
    let active = local.0.embedding_status();
    let reranker_active = local.0.reranker_status();
    Ok(DocsEmbeddingStatus {
        model_path,
        running: active.is_some(),
        base_url: active.map(|a| a.base_url),
        reranker: RerankerStatus {
            model_path: reranker_path,
            running: reranker_active.is_some(),
            base_url: reranker_active.map(|a| a.base_url),
        },
    })
}

/// Start the reranker sidecar for the installed reranker GGUF. Invoked by the
/// Knowledge panel when the user enables "Rerank search results", so the
/// first reranked search doesn't pay the model load. No-op (`false`) when the
/// sidecar is already up; errors when no reranker GGUF is found. The search
/// stage itself never starts the sidecar — it fails open when it's down.
#[tauri::command]
pub async fn docs_start_reranker(
    db: State<'_, DbState>,
    local: State<'_, LocalModelState>,
) -> CmdResult<bool> {
    if local.0.reranker_status().is_some() {
        return Ok(false);
    }
    let gguf = {
        let conn = db.0.lock();
        local_models::find_reranker_gguf(&conn)
    };
    let Some(gguf) = gguf else {
        return Err(
            "no reranker model installed — place a bge-reranker-v2-m3 GGUF (filename \
             containing \"reranker\") in your models folder"
                .to_string(),
        );
    };
    local.0.start_reranker(&gguf).await?;
    Ok(true)
}

#[tauri::command(async)]
pub fn docs_add_corpus(
    app: AppHandle,
    db: State<'_, DbState>,
    local: State<'_, LocalModelState>,
    registry: State<'_, Arc<IndexRegistry>>,
    path: String,
    name: Option<String>,
) -> CmdResult<docs_db::DocCorpus> {
    let canonical = crate::util::normalize_canonical_path(
        &std::fs::canonicalize(&path)
            .map_err(|e| format!("folder not readable: {e}"))?
            .to_string_lossy(),
    );
    let name = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            Path::new(&canonical)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| canonical.clone())
        });
    let corpus = {
        let conn = db.0.lock();
        if let Ok(Some(existing)) = docs_db::get_corpus_by_path(&conn, &canonical) {
            return Err(format!("folder is already indexed as '{}'", existing.name));
        }
        docs_db::add_corpus(&conn, &canonical, &name).map_err(|e| e.to_string())?
    };
    // New corpora are watched immediately (§5.25) — enablement is checked at
    // fire time, so even a disabled corpus's watcher is harmless.
    crate::docs_watcher::install(
        &app,
        &app.state::<crate::docs_watcher::DocsWatcherState>(),
        Arc::clone(&db.0),
        Arc::clone(&local.0),
        Arc::clone(&registry),
        Path::new(&corpus.path),
    );
    Ok(corpus)
}

#[tauri::command(async)]
pub fn docs_remove_corpus(
    app: AppHandle,
    db: State<'_, DbState>,
    corpus_id: String,
) -> CmdResult<()> {
    let path = {
        let conn = db.0.lock();
        let corpus = docs_db::get_corpus(&conn, &corpus_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "corpus not found".to_string())?;
        docs_db::remove_corpus(&conn, &corpus_id).map_err(|e| e.to_string())?;
        corpus.path
    };
    crate::docs_watcher::uninstall(
        &app.state::<crate::docs_watcher::DocsWatcherState>(),
        Path::new(&path),
    );
    Ok(())
}

#[tauri::command(async)]
pub fn docs_list_corpora(db: State<'_, DbState>) -> CmdResult<Vec<docs_db::DocCorpus>> {
    let conn = db.0.lock();
    docs_db::list_corpora(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn docs_set_corpus_enabled(
    app: AppHandle,
    db: State<'_, DbState>,
    local: State<'_, LocalModelState>,
    registry: State<'_, Arc<IndexRegistry>>,
    corpus_id: String,
    enabled: bool,
) -> CmdResult<()> {
    let path = {
        let conn = db.0.lock();
        docs_db::set_corpus_enabled(&conn, &corpus_id, enabled).map_err(|e| e.to_string())?;
        docs_db::get_corpus(&conn, &corpus_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "corpus not found".to_string())?
            .path
    };
    let state = app.state::<crate::docs_watcher::DocsWatcherState>();
    if enabled {
        crate::docs_watcher::install(
            &app,
            &state,
            Arc::clone(&db.0),
            Arc::clone(&local.0),
            Arc::clone(&registry),
            Path::new(&path),
        );
    } else {
        crate::docs_watcher::uninstall(&state, Path::new(&path));
    }
    Ok(())
}

/// Pin a corpus to a chat session so its documents are ALWAYS in that chat's
/// auto-retrieval context regardless of query (§3.1.7 per-chat attachment).
#[tauri::command(async)]
pub fn docs_attach_corpus_to_chat(
    db: State<'_, DbState>,
    chat_session_id: String,
    corpus_id: String,
) -> CmdResult<()> {
    let conn = db.0.lock();
    docs_db::attach_corpus_to_chat(&conn, &chat_session_id, &corpus_id).map_err(|e| e.to_string())
}

/// Remove a corpus from a chat's pinned set.
#[tauri::command(async)]
pub fn docs_detach_corpus_from_chat(
    db: State<'_, DbState>,
    chat_session_id: String,
    corpus_id: String,
) -> CmdResult<()> {
    let conn = db.0.lock();
    docs_db::detach_corpus_from_chat(&conn, &chat_session_id, &corpus_id).map_err(|e| e.to_string())
}

/// List the corpus ids pinned to a chat session (empty = none pinned).
#[tauri::command(async)]
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
    spawn_index_job(
        app,
        Arc::clone(&db.0),
        Arc::clone(&local.0),
        Arc::clone(&registry),
        corpus_id,
    )
}

/// Start a background index run for one corpus — the shared entry behind the
/// `docs_start_index` command AND the filesystem watcher (§5.25): a file
/// change inside an enabled corpus folder re-runs the incremental walk
/// (mtime/size diff → only changed files re-embed) without a manual Index
/// press. Errors are the command's user-facing strings; the watcher treats
/// them as "skip + log".
pub fn spawn_index_job(
    app: AppHandle,
    db: Arc<Mutex<Connection>>,
    local: Arc<LocalModelRegistry>,
    registry: Arc<IndexRegistry>,
    corpus_id: String,
) -> Result<(), String> {
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

    // Read everything we need up-front; the DB lock must not cross the spawn.
    let prepared = {
        let conn = db.lock();
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
        let gguf = if local.embedding_status().is_some() {
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
        let caption_base = caption_base_url(&conn, &local);
        (corpus, gguf, caption_base)
    };
    let (corpus, gguf_path, caption_base) = prepared;

    let db_arc = Arc::clone(&db);
    let local_arc = Arc::clone(&local);
    let registry_arc = Arc::clone(&registry);
    let app_for_task = app.clone();
    let corpus_id_for_task = corpus_id.clone();

    tauri::async_runtime::spawn(async move {
        // Panic-proof slot lease: the manual `registry.active.remove` after
        // `run_index` never ran when the task unwound, and the leaked slot
        // made every later Index press fail with "indexing already in
        // progress" until the app restarted. Drop runs on unwind too.
        struct SlotLease {
            registry: Arc<IndexRegistry>,
            corpus_id: String,
        }
        impl Drop for SlotLease {
            fn drop(&mut self) {
                self.registry.active.lock().remove(&self.corpus_id);
            }
        }
        let _lease = SlotLease {
            registry: Arc::clone(&registry_arc),
            corpus_id: corpus_id_for_task.clone(),
        };

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

        drop(_lease);

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

#[tauri::command(async)]
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
            // Stamp the chunk-schema version only on a COMPLETED pass — a
            // cancelled/errored run leaves chunks in mixed old/new shape, so
            // the stored version stays behind and the next run re-chunks
            // everything again.
            if progress.state == "done" {
                let _ = docs_db::stamp_corpus_chunk_version(
                    &conn,
                    &corpus_id,
                    docs_db::DOCS_CHUNK_SCHEMA_VERSION,
                );
            }
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
        // Corpus schema versioning: when the stored chunk_version lags the
        // current chunk-shape schema (chunker behavior + enrichment
        // metadata), treat EVERY file as changed — the mtime/size diff can
        // never see chunk-shape changes on its own.
        let stored_version = docs_db::corpus_chunk_version(&conn, &corpus_id).unwrap_or(0);
        let schema_outdated = stored_version < docs_db::DOCS_CHUNK_SCHEMA_VERSION;
        let changed = entries
            .into_iter()
            .filter(|e| schema_outdated || indexed.get(&e.rel_path) != Some(&(e.mtime, e.size)))
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

        let built: Option<(String, Vec<docs::ChunkMeta>)> = match entry.kind {
            docs::WalkKind::Text => match std::fs::read_to_string(&abs) {
                Ok(text) => {
                    // chunk_text_with_meta additionally tracks the markdown
                    // heading trail; since chunk-schema v2 the trail + the
                    // relative path are part of the EMBEDDED text (contextual
                    // enrichment) while the stored chunk content stays raw.
                    let mut metas = docs::chunk_text_with_meta(&text, &rel);
                    let remaining = docs::MAX_CHUNKS_PER_CORPUS - total_chunks;
                    metas.truncate(remaining);
                    if metas.is_empty() {
                        // Empty/whitespace file: still record it as indexed so
                        // the diff doesn't reprocess it every run.
                        None
                    } else {
                        Some(("text".to_string(), metas))
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
                        // Image surrogates have no heading trail.
                        Some((
                            "image".to_string(),
                            vec![docs::ChunkMeta {
                                content: surrogate,
                                heading: String::new(),
                            }],
                        ))
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

        let Some((kind, metas)) = built else {
            // Unreadable/empty file: record so the diff skips it next time.
            let conn = db.lock();
            let _ = docs_db::delete_chunks_for_file(&conn, &corpus_id, &rel);
            let _ = docs_db::upsert_indexed_file(&conn, &corpus_id, &rel, entry.mtime, entry.size);
            drop(conn);
            progress.processed_files += 1;
            continue;
        };

        // A dead sidecar fails every embed from here on — abort the run.
        // Embed the ENRICHED text (path · heading + content); the pairs kept
        // for storage still carry the raw content + heading.
        let texts: Vec<String> = metas
            .iter()
            .map(|m| docs::enriched_embed_text(&rel, &m.heading, &m.content))
            .collect();
        let vectors = match embed_all(&base_url, &texts).await {
            Ok(v) => v,
            Err(first) => {
                // One oversized chunk used to abort the WHOLE corpus run. The
                // common per-input failure is a too-long reject against a
                // server whose physical batch (ubatch) is smaller than the
                // chunk — our own sidecar now launches matched to its
                // context, but an externally-provided base_url (or an older
                // bundled binary) may still run the 512 default. Retry the
                // file once with the enriched texts cut to a conservative
                // head budget (~450 tokens worst case on prose, fits the 512
                // default; CJK ~1 token/char still fits our 2048 context).
                // The head keeps the path·heading prefix — the enrichment
                // that anchors retrieval. A second failure is a real sidecar
                // problem: abort with the ORIGINAL error (the shrunk retry's
                // error would just repeat it, less legibly).
                let shrunk: Vec<String> = texts
                    .iter()
                    .map(|t| t.chars().take(EMBED_RETRY_CHAR_CAP).collect())
                    .collect();
                match embed_all(&base_url, &shrunk).await {
                    Ok(v) => {
                        eprintln!(
                            "[docs] embedding failed for {rel} ({first}); retry with \
{EMBED_RETRY_CHAR_CAP}-char heads succeeded"
                        );
                        v
                    }
                    Err(_) => finish!("error", Some(format!("embedding failed for {rel}: {first}"))),
                }
            }
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
        let pairs: Vec<(String, Vec<f32>, String)> = metas
            .into_iter()
            .zip(vectors)
            .map(|(m, v)| (m.content, v, m.heading))
            .collect();

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
        // Even with no settings, the ~/Relay/models default is present.
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
        let tmp = std::env::temp_dir().join(format!("relay-docs-test-{}", std::process::id()));
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
        let tmp = std::env::temp_dir().join(format!("relay-docs-test2-{}", std::process::id()));
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
        let default = dirs::home_dir().map(|h| crate::user_dirs::default_models_dir(&h));
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
