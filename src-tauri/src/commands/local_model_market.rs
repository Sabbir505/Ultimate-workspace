//! Hugging Face "model market" — browse, search, and download GGUF models
//! from the Hugging Face Hub, then point the existing local-model scanner
//! at the destination folder so they show up in the chat model picker
//! without any further wiring.
//!
//! Design choices (kept deliberately small):
//!
//! * **Anonymous by default**, optional HF read token. The token is stored
//!   in the OS keychain (same pattern as `secrets::set_chat_api_key`) and
//!   never returned to the frontend — the JS side just gets a
//!   `hasHuggingFaceToken` bool.
//! * **Server-side fetch** via `reqwest` — the frontend never calls HF
//!   directly, so CORS is irrelevant and the user does not need a CORS
//!   extension in their browser.
//! * **Streaming download with progress events** mirroring the updater
//!   pattern (`commands/updater_cmds.rs`). The download writes to
//!   `<dest>/<file>.gguf.partial` and atomically renames to `.gguf` once
//!   the SHA-256 (when the catalog exposes one) matches.
//! * **Cancel** via a per-download `oneshot`. Cancelling deletes the
//!   `.partial` file.
//! * **Gated repos** (e.g. license click-through) are detected by a
//!   401/403 and surfaced to the user as a friendly message pointing
//!   them at `huggingface.co/{model_id}`.
//!
//! Catalog data is fetched live from the Hub
//! (`/api/models?filter=gguf&sort=downloads`) and normalized into the
//! `CatalogEntry` shape the UI consumes. We do *not* maintain a static
//! catalog — HF's search ranking is the only signal users actually care
//! about ("what's good for code? what's hot this week?").

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;

use crate::db;
use crate::DbState;
use crate::secrets;

type CmdResult<T> = Result<T, String>;

// ---- Catalog types (the shape the UI consumes) ----

/// What the UI shows on a market card. We don't return the raw HF blob —
/// the JSON is normalized server-side so the frontend doesn't depend on
/// HF's schema.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    /// Stable id = `{repo}/{filename-without-gguf}`. Used to address a
    /// download.
    pub id: String,
    /// Human-friendly display name (the GGUF file's basename).
    pub display_name: String,
    /// Hugging Face author (org or user).
    pub author: String,
    /// Hugging Face repo id (e.g. "TheBloke/Llama-2-7B-Chat-GGUF").
    pub repo_id: String,
    /// Filename inside the repo (e.g. "llama-2-7b-chat.Q4_K_M.gguf").
    pub filename: String,
    /// Total downloads for this repo (used for the "popular" badge).
    pub downloads: u64,
    /// Likes for this repo (HF heart count).
    pub likes: u64,
    /// Last-modified timestamp (RFC3339 from HF), if available.
    pub last_modified: Option<String>,
    /// Size in bytes (from the HF `siblings` listing).
    pub size_bytes: u64,
    /// Free-form description (first ~300 chars of the model card).
    pub description: Option<String>,
    /// Tags, deduplicated and lower-cased.
    pub tags: Vec<String>,
    /// SHA-256 from HF's `siblings[].sha256` field, when present.
    pub sha256: Option<String>,
    /// Download URL (the raw file URL).
    pub download_url: String,
    /// Whether the file is a vision/multimodal GGUF (best-effort).
    pub vision: bool,
    /// Best-effort parameter-count label (e.g. "7B", "13B", "70B").
    pub params_label: Option<String>,
    /// Best-effort quantization label (e.g. "Q4_K_M", "Q5_1", "F16").
    pub quantization: Option<String>,
    /// License pulled from the model card tags.
    pub license: Option<String>,
    /// True when the repo requires a license click-through on HF. We can
    /// only detect this empirically on the first download attempt; the UI
    /// shows a "may be gated" hint.
    pub gated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchCatalogResult {
    pub entries: Vec<CatalogEntry>,
    /// True when an HF token is configured (anonymous otherwise). UI uses
    /// this to show a small badge / hint in the panel.
    pub has_hugging_face_token: bool,
    /// Default directory where new models will be saved (if not yet
    /// persisted, the user hasn't picked one — UI shows the picker).
    pub default_models_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub state: DownloadState,
    /// Average throughput in bytes/second, computed from elapsed time.
    pub bytes_per_second: f64,
    /// Final destination path, populated on the terminal `Done` event so
    /// the UI can immediately re-scan the directory.
    pub final_path: Option<String>,
    /// Human-readable error message, populated on the `Error` state.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    Starting,
    Downloading,
    Verifying,
    Done,
    Error,
    Cancelled,
}

// ---- In-flight downloads (Tauri-managed state) ----

/// One in-flight (or recently completed) download, keyed by `id`.
pub struct DownloadSlot {
    pub cancel: Option<oneshot::Sender<()>>,
}

pub struct DownloadRegistry {
    pub active: Mutex<HashMap<String, DownloadSlot>>,
}

impl Default for DownloadRegistry {
    fn default() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
        }
    }
}

// ---- HF token store (reuses the OS keychain via `secrets`) ----

const HF_TOKEN_NAMESPACE: &str = "market";
const HF_TOKEN_KEY: &str = "huggingface_token";

fn get_hf_token(conn: &rusqlite::Connection) -> Option<String> {
    secrets::platform_load(conn, HF_TOKEN_NAMESPACE, HF_TOKEN_KEY)
}

fn set_hf_token(conn: &rusqlite::Connection, token: &str) -> Result<(), String> {
    secrets::platform_store(conn, HF_TOKEN_NAMESPACE, HF_TOKEN_KEY, token)
}

fn clear_hf_token(conn: &rusqlite::Connection) {
    secrets::platform_remove(conn, HF_TOKEN_NAMESPACE, HF_TOKEN_KEY);
}

// ---- Models dir setting ----

const MODELS_DIR_SETTING: &str = "local_models.dir";

fn get_models_dir(conn: &rusqlite::Connection) -> Option<String> {
    db::get_setting(conn, MODELS_DIR_SETTING).ok().flatten()
}

fn set_models_dir(conn: &rusqlite::Connection, dir: &str) -> Result<(), String> {
    db::set_setting(conn, MODELS_DIR_SETTING, dir).map_err(|e| e.to_string())
}

/// Resolved destination for a new download. Falls back to
/// `~/Conduit/models` if the user hasn't picked one yet (and creates it
/// on first use — this is the "default folder" promised in the UI).
fn resolve_models_dir(conn: &rusqlite::Connection) -> Result<PathBuf, String> {
    if let Some(s) = get_models_dir(conn) {
        return Ok(PathBuf::from(s));
    }
    let home = dirs_home().ok_or_else(|| "no home directory".to_string())?;
    Ok(home.join("Conduit").join("models"))
}

fn dirs_home() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

// ---- HF API: raw model shape + catalog fetch ----

/// Subset of the HF `GET /api/models` response we care about. The real
/// response is huge; we just project the fields we use.
#[derive(Deserialize)]
struct HfModel {
    id: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    last_modified: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    /// `siblings` lists the files in the repo. We use this to find the
    /// GGUF filename + size + sha256.
    #[serde(default)]
    siblings: Vec<HfSibling>,
}

#[derive(Deserialize)]
struct HfSibling {
    rfilename: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    sha256: Option<String>,
}

/// Build a `reqwest::Client` with sensible defaults: a real UA (HF blocks
/// empty UAs), timeouts that don't hang the UI, and TLS.
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Conduit/0.3.2 (desktop; +https://conduit.app)")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

fn build_hf_request(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut r = client.get(url);
    if let Some(t) = token {
        if !t.is_empty() {
            r = r.bearer_auth(t);
        }
    }
    r
}

fn normalize_hf_model(m: HfModel) -> Vec<CatalogEntry> {
    let mut out = Vec::new();
    let author = m.id.split('/').next().unwrap_or("").to_string();
    let description = m
        .description
        .as_deref()
        .map(|s| s.chars().take(300).collect::<String>());

    let license = m
        .tags
        .iter()
        .find(|t| t.starts_with("license:"))
        .map(|t| t.trim_start_matches("license:").to_string());

    for s in m.siblings {
        if !s.rfilename.to_ascii_lowercase().ends_with(".gguf") {
            continue;
        }
        let size = s.size.unwrap_or(0);
        let id = format!("{}::{}", m.id, s.rfilename);
        let download_url =
            format!("https://huggingface.co/{}/resolve/main/{}", m.id, s.rfilename);
        let lower = s.rfilename.to_ascii_lowercase();
        let quant = extract_quantization(&lower);
        let params = extract_params_label(&lower, &m.id.to_ascii_lowercase());
        let vision = lower.contains("mmproj")
            || m.tags.iter().any(|t| t == "multimodal" || t == "vision");
        out.push(CatalogEntry {
            id,
            display_name: s.rfilename.trim_end_matches(".gguf").to_string(),
            author: author.clone(),
            repo_id: m.id.clone(),
            filename: s.rfilename.clone(),
            downloads: m.downloads,
            likes: m.likes,
            last_modified: m.last_modified.clone(),
            size_bytes: size,
            description: description.clone(),
            tags: m.tags.clone(),
            sha256: s.sha256.clone(),
            download_url,
            vision,
            params_label: params,
            quantization: quant,
            license: license.clone(),
            gated: false, // resolved on first download attempt
        });
    }
    out
}

/// Pull a quantization label from a filename. Matches the common cases:
/// "Q4_K_M", "Q4_0", "Q5_1", "Q8_0", "F16", "BF16", "IQ4_XS".
fn extract_quantization(lower_filename: &str) -> Option<String> {
    for needle in [
        "q2_k", "q3_k_s", "q3_k_m", "q3_k_l", "q4_0", "q4_1", "q4_k_s", "q4_k_m", "q5_0",
        "q5_1", "q5_k_s", "q5_k_m", "q6_k", "q8_0", "iq1_s", "iq2_xxs", "iq2_xs", "iq2_s",
        "iq2_m", "iq3_xxs", "iq3_xs", "iq3_s", "iq3_m", "iq4_nl", "iq4_xs", "iq4_s", "iq4_m",
        "f16", "f32", "bf16",
    ] {
        if lower_filename.contains(needle) {
            return Some(needle.to_ascii_uppercase());
        }
    }
    None
}

/// Best-effort "7B" / "13B" / "70B" label. Look in the filename first
/// (e.g. "llama-3-8b-instruct.Q4_K_M.gguf"), then fall back to the repo
/// id.
fn extract_params_label(lower_filename: &str, lower_repo: &str) -> Option<String> {
    for hay in [lower_filename, lower_repo] {
        let bytes = hay.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if !bytes[i].is_ascii_digit() {
                i += 1;
                continue;
            }
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            // Optional dot before 'b' (e.g. "8.0B").
            if i < bytes.len() && bytes[i] == b'.' {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'b' {
                let after = bytes.get(i + 1).copied().unwrap_or(0);
                let boundary = i + 1 == bytes.len() || !after.is_ascii_alphanumeric();
                if boundary {
                    let num = std::str::from_utf8(&bytes[start..i])
                        .ok()
                        .and_then(|s| s.parse::<u32>().ok());
                    if let Some(n) = num {
                        if (1..=1000).contains(&n) {
                            return Some(format!("{n}B"));
                        }
                    }
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchCatalogArgs {
    pub query: Option<String>,
    /// "downloads" | "likes" | "modified" | "trending".
    pub sort: Option<String>,
    /// Max entries to return. HF paginates at 1000; we cap here too.
    pub limit: Option<u32>,
}

// Kept for callers that want to import the arg type, but Tauri's
// `#[command]` macro flattens these into separate parameters.
#[allow(dead_code)]
impl FetchCatalogArgs {
    pub fn new(query: Option<String>, sort: Option<String>, limit: Option<u32>) -> Self {
        Self { query, sort, limit }
    }
}

#[tauri::command]
pub async fn fetch_model_catalog(
    db: State<'_, DbState>,
    query: Option<String>,
    sort: Option<String>,
    limit: Option<u32>,
) -> CmdResult<FetchCatalogResult> {
    // Pull everything we need from the DB *before* the first await so the
    // `State<DbState>` (which is !Send across an await) doesn't end up
    // held while we wait on HTTP.
    let (token, default_models_dir) = {
        let conn = db.0.lock();
        let t = get_hf_token(&conn);
        let d = resolve_models_dir(&conn)
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
        (t, d)
    };

    let limit = limit.unwrap_or(60).min(200);
    let query = query.unwrap_or_default();
    let sort = sort.unwrap_or_else(|| "downloads".to_string());

    let client = http_client();

    let url = if !query.trim().is_empty() {
        format!(
            "https://huggingface.co/api/models?search={}&filter=gguf&limit={limit}",
            urlencoding_lite(&query)
        )
    } else {
        let sort_param = match sort.as_str() {
            "likes" => "likes",
            "modified" => "modified",
            _ => "downloads",
        };
        format!(
            "https://huggingface.co/api/models?filter=gguf&sort={sort_param}&direction=-1&limit={limit}"
        )
    };

    let mut entries: Vec<CatalogEntry> = Vec::new();
    let resp = build_hf_request(&client, &url, token.as_deref())
        .send()
        .await
        .map_err(|e| format!("HF catalog request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HF returned HTTP {status} for catalog"));
    }
    let models: Vec<HfModel> = resp
        .json()
        .await
        .map_err(|e| format!("HF catalog parse failed: {e}"))?;

    for m in models {
        entries.extend(normalize_hf_model(m));
    }
    entries.truncate(limit as usize);

    Ok(FetchCatalogResult {
        entries,
        has_hugging_face_token: token.is_some(),
        default_models_dir,
    })
}

/// Tiny URL-encoder — we only need to escape spaces, `&`, `=`, and `+`
/// for HF's free-text `search` query. Avoids pulling in a full
/// `urlencoding` crate.
fn urlencoding_lite(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '&' => out.push_str("%26"),
            '=' => out.push_str("%3D"),
            '+' => out.push_str("%2B"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            c if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') => {
                out.push(c);
            }
            c => out.push_str(&format!("%{:02X}", c as u32)),
        }
    }
    out
}

// ---- Settings commands (dir + token) ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSettings {
    /// User-picked dir, if any.
    pub models_dir: Option<String>,
    /// Effective default if the user hasn't picked one (used as the
    /// initial value in the folder picker).
    pub default_models_dir: Option<String>,
    pub has_hugging_face_token: bool,
}

#[tauri::command]
pub fn get_market_settings(db: State<'_, DbState>) -> CmdResult<MarketSettings> {
    let conn = db.0.lock();
    Ok(MarketSettings {
        models_dir: get_models_dir(&conn),
        default_models_dir: resolve_models_dir(&conn)
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
        has_hugging_face_token: get_hf_token(&conn).is_some(),
    })
}

#[tauri::command]
pub fn set_models_directory(db: State<'_, DbState>, dir: String) -> CmdResult<()> {
    if dir.trim().is_empty() {
        return Err("empty path".to_string());
    }
    let conn = db.0.lock();
    set_models_dir(&conn, dir.trim())?;
    Ok(())
}

#[tauri::command]
pub fn set_hugging_face_token(db: State<'_, DbState>, token: String) -> CmdResult<()> {
    let trimmed = token.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty token".to_string());
    }
    let conn = db.0.lock();
    set_hf_token(&conn, &trimmed)?;
    Ok(())
}

#[tauri::command]
pub fn clear_hugging_face_token(db: State<'_, DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    clear_hf_token(&conn);
    Ok(())
}

/// Open the OS folder picker. Returns the picked path or null if the
/// user cancelled. We use the Tauri dialog plugin directly from Rust
/// (not the JS wrapper) so the JS call site can stay a one-liner.
#[tauri::command]
pub async fn pick_models_directory(app: AppHandle) -> CmdResult<Option<String>> {
    let (tx, rx) = oneshot::channel();
    let _ = app
        .dialog()
        .file()
        .set_title("Choose where to save downloaded models")
        .pick_folder(move |maybe_path| {
            let _ = tx.send(maybe_path);
        });
    let path = rx.await.map_err(|e| e.to_string())?;
    Ok(path
        .and_then(|p| p.into_path().ok())
        .map(|pb| pb.to_string_lossy().into_owned()))
}

// ---- Download pipeline ----

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDownloadArgs {
    pub id: String,
    pub repo_id: String,
    pub filename: String,
    pub download_url: String,
    pub expected_sha256: Option<String>,
    /// Destination folder. If omitted, falls back to the persisted
    /// models_dir, then to `~/Conduit/models` (created on demand).
    pub dest_dir: Option<String>,
}

#[tauri::command]
pub async fn start_model_download(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, Arc<DownloadRegistry>>,
    id: String,
    repo_id: String,
    filename: String,
    download_url: String,
    expected_sha256: Option<String>,
    dest_dir: Option<String>,
) -> CmdResult<()> {
    {
        let reg = registry.active.lock();
        if reg.contains_key(&id) {
            return Err("download already in progress for this model".to_string());
        }
    }

    // Read everything we need from the DB up-front; the State guard must
    // not be held across the spawn's await.
    let (dest_dir, token) = {
        let conn = db.0.lock();
        let d = if let Some(p) = dest_dir.as_ref().filter(|s| !s.is_empty()) {
            PathBuf::from(p)
        } else {
            resolve_models_dir(&conn)?
        };
        let t = get_hf_token(&conn);
        (d, t)
    };

    fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| format!("could not create dest dir: {e}"))?;

    // Sanitize the filename (HF allows a wide range of chars; the OS
    // may reject some). Replace any path-separator / control char with
    // `_`.
    let safe_filename: String = filename
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let final_path = dest_dir.join(&safe_filename);
    let partial_path = dest_dir.join(format!("{safe_filename}.partial"));

    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut reg = registry.active.lock();
        reg.insert(
            id.clone(),
            DownloadSlot {
                cancel: Some(cancel_tx),
            },
        );
    }

    let id_for_task = id.clone();
    let app_for_task = app.clone();
    let registry_for_task = Arc::clone(&registry);
    let url_for_task = download_url.clone();
    let token_for_task = token.clone();
    let expected_sha = expected_sha256.clone();

    tauri::async_runtime::spawn(async move {
        let result = run_download(
            &app_for_task,
            &id_for_task,
            &url_for_task,
            token_for_task.as_deref(),
            &partial_path,
            &final_path,
            expected_sha.as_deref(),
            cancel_rx,
        )
        .await;

        {
            let mut reg = registry_for_task.active.lock();
            reg.remove(&id_for_task);
        }

        let progress = match result {
            Ok(()) => DownloadProgress {
                id: id_for_task.clone(),
                downloaded_bytes: 0,
                total_bytes: None,
                state: DownloadState::Done,
                bytes_per_second: 0.0,
                final_path: Some(final_path.to_string_lossy().into_owned()),
                error: None,
            },
            Err(DownloadAbort::Cancelled) => DownloadProgress {
                id: id_for_task.clone(),
                downloaded_bytes: 0,
                total_bytes: None,
                state: DownloadState::Cancelled,
                bytes_per_second: 0.0,
                final_path: None,
                error: None,
            },
            Err(DownloadAbort::Failed(msg)) => DownloadProgress {
                id: id_for_task.clone(),
                downloaded_bytes: 0,
                total_bytes: None,
                state: DownloadState::Error,
                bytes_per_second: 0.0,
                final_path: None,
                error: Some(msg),
            },
        };
        let _ = app_for_task.emit("local-model:download:progress", &progress);
    });

    // Fire a single Starting event so the UI can move the card into the
    // "downloading" state immediately.
    let _ = app.emit(
        "local-model:download:progress",
        &DownloadProgress {
            id: id.clone(),
            downloaded_bytes: 0,
            total_bytes: None,
            state: DownloadState::Starting,
            bytes_per_second: 0.0,
            final_path: None,
            error: None,
        },
    );

    Ok(())
}

#[derive(Debug)]
enum DownloadAbort {
    Cancelled,
    Failed(String),
}

impl<E: std::fmt::Display> From<E> for DownloadAbort {
    fn from(e: E) -> Self {
        Self::Failed(e.to_string())
    }
}

async fn run_download(
    app: &AppHandle,
    id: &str,
    url: &str,
    token: Option<&str>,
    partial_path: &Path,
    final_path: &Path,
    expected_sha: Option<&str>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), DownloadAbort> {
    let client = http_client();
    let mut req = client.get(url);
    if let Some(t) = token {
        if !t.is_empty() {
            req = req.bearer_auth(t);
        }
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("download request failed: {e}"))?;
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        let _ = fs::remove_file(partial_path).await;
        return Err(DownloadAbort::Failed(
            "this model is gated — open it on huggingface.co to accept the license, \
             or set a Hugging Face access token in Settings → Local Models."
                .to_string(),
        ));
    }
    if !status.is_success() {
        return Err(DownloadAbort::Failed(format!("HTTP {status}")));
    }
    let total = resp.content_length();
    let mut stream = resp.bytes_stream();

    let mut file = fs::File::create(partial_path)
        .await
        .map_err(|e| format!("could not create .partial file: {e}"))?;

    let mut downloaded: u64 = 0;
    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut hasher = expected_sha.map(|_| Sha256::new());

    loop {
        tokio::select! {
            biased;
            _ = &mut cancel_rx => {
                drop(file);
                let _ = fs::remove_file(partial_path).await;
                return Err(DownloadAbort::Cancelled);
            }
            next = stream.next() => {
                let Some(chunk) = next else { break };
                let chunk = chunk.map_err(|e| format!("download stream error: {e}"))?;
                if chunk.is_empty() { continue; }
                file.write_all(&chunk).await.map_err(|e| format!("write error: {e}"))?;
                if let Some(h) = hasher.as_mut() {
                    h.update(&chunk);
                }
                downloaded = downloaded.saturating_add(chunk.len() as u64);
                if last_emit.elapsed().as_millis() >= 150 {
                    let elapsed = started.elapsed().as_secs_f64().max(0.001);
                    let _ = app.emit(
                        "local-model:download:progress",
                        &DownloadProgress {
                            id: id.to_string(),
                            downloaded_bytes: downloaded,
                            total_bytes: total,
                            state: DownloadState::Downloading,
                            bytes_per_second: downloaded as f64 / elapsed,
                            final_path: None,
                            error: None,
                        },
                    );
                    last_emit = Instant::now();
                }
            }
        }
    }

    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    drop(file);

    if let (Some(expected), Some(h)) = (expected_sha, hasher) {
        let digest = h.finalize();
        let got = format!("{:x}", digest);
        if !got.eq_ignore_ascii_case(expected) {
            let _ = fs::remove_file(partial_path).await;
            return Err(DownloadAbort::Failed(format!(
                "SHA-256 mismatch (expected {expected}, got {got})"
            )));
        }
    }

    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir: {e}"))?;
    }
    fs::rename(partial_path, final_path)
        .await
        .map_err(|e| format!("rename to final path failed: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn cancel_model_download(
    registry: State<'_, Arc<DownloadRegistry>>,
    id: String,
) -> CmdResult<()> {
    let mut reg = registry.active.lock();
    if let Some(mut slot) = reg.remove(&id) {
        if let Some(tx) = slot.cancel.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}
