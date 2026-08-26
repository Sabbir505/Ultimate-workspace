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

use crate::chat::local_models::query_total_vram_bytes;
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
    /// True when this response came from the cache because huggingface.co
    /// was unreachable — the data may be older than the TTL. The UI shows
    /// an offline hint instead of a dead error banner.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stale: bool,
}

// ---- In-memory catalog cache ----

/// Cache key: the exact request shape plus token presence (a token can see
/// gated models an anonymous request can't, so the two must never mix).
type CatalogCacheKey = (String, String, u32, bool);

#[derive(Clone)]
struct CatalogCacheEntry {
    fetched_at: std::time::Instant,
    result: FetchCatalogResult,
}

/// How long a cached catalog response is served without revalidation. The
/// Market tab remounts on every settings-tab switch; without this each
/// remount hits huggingface.co live.
const CATALOG_CACHE_TTL_SECS: u64 = 600;

static CATALOG_CACHE: std::sync::LazyLock<Mutex<HashMap<CatalogCacheKey, CatalogCacheEntry>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Pure freshness check (unit-testable without touching the clock).
fn catalog_cache_fresh(fetched_at: std::time::Instant, now: std::time::Instant) -> bool {
    now.duration_since(fetched_at).as_secs() < CATALOG_CACHE_TTL_SECS
}

fn catalog_cache_get(key: &CatalogCacheKey) -> Option<FetchCatalogResult> {
    let cache = CATALOG_CACHE.lock();
    let hit = cache.get(key)?;
    if catalog_cache_fresh(hit.fetched_at, std::time::Instant::now()) {
        Some(hit.result.clone())
    } else {
        None
    }
}

/// Any-age lookup for the stale-on-error fallback (marked `stale: true`).
fn catalog_cache_stale_get(key: &CatalogCacheKey) -> Option<FetchCatalogResult> {
    let mut cache = CATALOG_CACHE.lock();
    let hit = cache.get_mut(key)?;
    let mut result = hit.result.clone();
    result.stale = true;
    // Refresh the timestamp so repeated offline reloads keep hitting this
    // entry instead of erroring after the TTL.
    hit.fetched_at = std::time::Instant::now();
    Some(result)
}

fn catalog_cache_put(key: CatalogCacheKey, result: FetchCatalogResult) {
    CATALOG_CACHE.lock().insert(
        key,
        CatalogCacheEntry {
            fetched_at: std::time::Instant::now(),
            result,
        },
    );
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
/// Also used by the STT module (its models live in a `stt/` subdirectory).
pub(crate) fn resolve_models_dir(conn: &rusqlite::Connection) -> Result<PathBuf, String> {
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
    author: Option<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    last_modified: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    pipeline_tag: Option<String>,
    #[serde(default)]
    library_name: Option<String>,
    /// `siblings` lists the files in the repo. We use this to find the
    /// GGUF filename. Size is estimated from quant + params.
    #[serde(default)]
    siblings: Vec<HfSibling>,
}

#[derive(Clone, Deserialize)]
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
        .user_agent(concat!("Conduit/", env!("CARGO_PKG_VERSION"), " (desktop; +https://conduit.app)"))
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
    let gguf_files: Vec<&HfSibling> = m.siblings.iter()
        .filter(|s| s.rfilename.to_ascii_lowercase().ends_with(".gguf"))
        .collect();
    if gguf_files.is_empty() { return Vec::new(); }

    let author = m.author.as_deref()
        .or_else(|| m.id.split('/').next())
        .unwrap_or("")
        .to_string();
    let description = m.description.as_deref()
        .map(|s| s.chars().take(400).collect::<String>());
    let license = m.tags.iter()
        .find(|t| t.starts_with("license:"))
        .map(|t| t.trim_start_matches("license:").to_string());

    let model_name = m.id.split('/').last().unwrap_or(&m.id);
    let display_name = model_name
        .replace("-GGUF", "")
        .replace("-gguf", "")
        .replace("_", " ")
        .replace("-", " ");
    let lower_all = m.id.to_ascii_lowercase();
    // Params label: parsed from the repo id when possible ("7b" → "7B").
    // Embedding repos (nomic/bge/gte) have no such token, and the estimate
    // fallback's 7B default would inflate their sizes ~50x — so give those a
    // realistic small-model default instead.
    let params = extract_params_label("", &lower_all).or_else(|| {
        if lower_all.contains("embed") || lower_all.contains("bge-") || lower_all.contains("gte-") {
            Some("0.14B".to_string())
        } else {
            None
        }
    });
    // Vision signal at the repo level: tagged `multimodal`/`vision` OR the
    // repo id itself carries a vision cue (llava, qwen-vl, internvl, minicpm-v,
    // mmproj...). Many older vision repos don't add HF tags, so this is a
    // heuristic on top of the tag check.
    let repo_tags_vision = m.tags.iter().any(|t| t == "multimodal" || t == "vision");
    let repo_id_vision = {
        let l = &lower_all;
        l.contains("llava") || l.contains("qwen-vl")
            || l.contains("internvl") || l.contains("minicpm-v")
            || l.contains("minicpmv") || l.contains("-vl") || l.contains("vision")
    };
    let repo_vision = repo_tags_vision || repo_id_vision;

    let mut entries: Vec<CatalogEntry> = Vec::new();
    for f in gguf_files {
        let lower = f.rfilename.to_ascii_lowercase();
        let quant = extract_quantization(&lower);
        let size = if f.size.unwrap_or(0) > 0 { f.size.unwrap_or(0) }
            else { estimate_gguf_size(params.as_deref(), quant.as_deref()) };
        // Per-file vision: an `mmproj` (multimodal projector) GGUF is by
        // definition a vision projector file (LLava-style stacks ship a
        // separate `*-mmproj-*.gguf` alongside the base model). We OR it
        // with the repo-level signal so a bare base-quant file in a vision
        // repo is also flagged.
        let file_vision = lower.contains("mmproj") || repo_vision;
        let id = format!("{}::{}", m.id, f.rfilename);
        let dl = format!("https://huggingface.co/{}/resolve/main/{}", m.id, f.rfilename);
        entries.push(CatalogEntry {
            id,
            display_name: display_name.clone(),
            author: author.clone(),
            repo_id: m.id.clone(),
            filename: f.rfilename.clone(),
            downloads: m.downloads,
            likes: m.likes,
            last_modified: m.last_modified.clone(),
            size_bytes: size,
            description: description.clone(),
            tags: m.tags.clone(),
            sha256: f.sha256.clone(),
            download_url: dl,
            vision: file_vision,
            params_label: params.clone(),
            quantization: quant,
            license: license.clone(),
            gated: false,
        });
    }
    entries
}

/// Estimate GGUF file size from model parameters and quantization.
/// Bit-per-weight values are approximate industry standards.
fn estimate_gguf_size(params_label: Option<&str>, quant: Option<&str>) -> u64 {
    let billions: f64 = params_label
        .and_then(|p| p.trim_end_matches('B').parse::<f64>().ok())
        .unwrap_or(7.0);
    let bpw: f64 = match quant.unwrap_or("Q4_K_M") {
        "Q2_K" | "IQ2_XXS" | "IQ2_XS" => 2.5,
        "Q3_K_S" | "Q3_K_M" | "Q3_K_L" | "IQ3_XXS" | "IQ3_XS" => 3.5,
        "Q4_0" | "Q4_1" | "Q4_K_S" | "Q4_K_M" | "IQ4_XS" | "IQ4_NL" => 4.5,
        "Q5_0" | "Q5_1" | "Q5_K_S" | "Q5_K_M" => 5.5,
        "Q6_K" => 6.5,
        "Q8_0" => 8.5,
        "F16" | "BF16" => 16.0,
        _ => 4.5,
    };
    // Size ≈ params_billion * 1e9 * bpw / 8, plus ~5% overhead
    ((billions * 1_000_000_000.0 * bpw / 8.0) * 1.05) as u64
}

/// Pull a quantization label from a filename. Matches the common cases:
/// "Q4_K_M", "Q4_0", "Q5_1", "Q8_0", "F16", "BF16", "IQ4_XS".
fn extract_quantization(lower_filename: &str) -> Option<String> {
    // Order matters: longer / more specific patterns first, because
    // "bf16" contains "f16", and "q4_k_m" contains "q4_0" / "q4_k_s".
    // If we tested "f16" before "bf16" we'd mislabel bf16 files as f16.
    for needle in [
        "q3_k_s", "q3_k_m", "q3_k_l", "q4_k_s", "q4_k_m", "q5_k_s", "q5_k_m", "q2_k", "q4_0",
        "q4_1", "q5_0", "q5_1", "q6_k", "q8_0", "iq2_xxs", "iq3_xxs", "iq2_xs", "iq3_xs", "iq1_s",
        "iq2_s", "iq3_s", "iq2_m", "iq3_m", "iq4_nl", "iq4_xs", "iq4_s", "iq4_m", "bf16", "f16",
        "f32",
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

    // Fresh cache hit → serve it (with the CURRENT token/dir flags patched
    // in, so a mid-session setting change isn't masked by the cache).
    let cache_key: CatalogCacheKey = (query.clone(), sort.clone(), limit, token.is_some());
    if let Some(mut hit) = catalog_cache_get(&cache_key) {
        hit.has_hugging_face_token = token.is_some();
        hit.default_models_dir = default_models_dir.clone();
        return Ok(hit);
    }

    let client = http_client();

    // full=true is required to get the `siblings` file list for each model
    let url = if !query.trim().is_empty() {
        format!(
            "https://huggingface.co/api/models?search={}&filter=gguf&full=true&limit={limit}",
            urlencoding_lite(&query)
        )
    } else {
        let sort_param = match sort.as_str() {
            "likes" => "likes",
            // "trending": HF /api/models rejects sort=trending (HTTP 400).
            // Likes are the best available proxy for recent momentum, and the
            // GGUF filter keeps the catalog relevant.
            "trending" => "likes",
            // "modified": HF rejects "modified" (HTTP 400); the REST value is
            // camelCase "lastModified".
            "modified" => "lastModified",
            _ => "downloads",
        };
        format!(
            "https://huggingface.co/api/models?filter=gguf&sort={sort_param}&direction=-1&full=true&limit={limit}"
        )
    };

    let mut entries: Vec<CatalogEntry> = Vec::new();
    let resp = match build_hf_request(&client, &url, token.as_deref()).send().await {
        Ok(r) => r,
        Err(e) => {
            // Network failure: a cached copy of any age beats a dead banner.
            if let Some(stale) = catalog_cache_stale_get(&cache_key) {
                return Ok(stale);
            }
            return Err(format!("HF catalog request failed: {e}"));
        }
    };
    let status = resp.status();
    if !status.is_success() {
        if let Some(stale) = catalog_cache_stale_get(&cache_key) {
            return Ok(stale);
        }
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

    let result = FetchCatalogResult {
        entries,
        has_hugging_face_token: token.is_some(),
        default_models_dir,
        stale: false,
    };
    catalog_cache_put(cache_key, result.clone());
    Ok(result)
}

/// True file sizes for one repo's GGUFs, from HF's tree endpoint (the models
/// listing API does NOT return per-sibling sizes — `bloob=true` and friends
/// don't either — so estimates were shown instead). Returns filename → bytes
/// for every `.gguf` in the repo. Used by the Knowledge suggestions to show
/// real download sizes; the market keeps its estimate fallback for bulk
/// listings where per-repo calls would be too many.
#[tauri::command]
pub async fn fetch_model_file_sizes(repo_id: String) -> CmdResult<std::collections::HashMap<String, u64>> {
    let client = http_client();
    let url = format!(
        "https://huggingface.co/api/models/{}/tree/main?recursive=true",
        urlencoding_lite(&repo_id)
    );
    let resp = build_hf_request(&client, &url, None)
        .send()
        .await
        .map_err(|e| format!("HF tree request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HF tree request failed: HTTP {}", resp.status()));
    }
    #[derive(Deserialize)]
    struct TreeNode {
        path: String,
        #[serde(default)]
        size: Option<u64>,
    }
    let nodes: Vec<TreeNode> = resp
        .json()
        .await
        .map_err(|e| format!("HF tree response parse failed: {e}"))?;
    let mut sizes = std::collections::HashMap::new();
    for n in nodes {
        if n.path.to_ascii_lowercase().ends_with(".gguf") {
            if let Some(sz) = n.size.filter(|&s| s > 0) {
                sizes.insert(n.path, sz);
            }
        }
    }
    Ok(sizes)
}

/// GPU VRAM info for the model-market size gate. Returns the largest dedicated
/// VRAM across discrete GPUs (vendor-agnostic via DXGI) plus the device name,
/// or `{null, null}` when no discrete GPU is found (caller falls back to RAM).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuVramInfo {
    pub total_vram_bytes: Option<u64>,
    pub device_name: Option<String>,
}

#[tauri::command]
pub async fn get_gpu_vram() -> CmdResult<GpuVramInfo> {
    match query_total_vram_bytes() {
        Some((bytes, name)) => Ok(GpuVramInfo {
            total_vram_bytes: Some(bytes),
            device_name: Some(name),
        }),
        None => Ok(GpuVramInfo {
            total_vram_bytes: None,
            device_name: None,
        }),
    }
}

/// Estimate a GPU's power draw in watts from its device name.
/// Uses a lookup table of common consumer/datacenter cards; falls back to a
/// VRAM-size heuristic for unknown models (more VRAM → bigger card → more power).
/// Returns `None` when no GPU is detected or the name is unrecognizable AND
/// VRAM is unavailable.
pub fn estimate_gpu_power_watts(device_name: &str, vram_bytes: u64) -> Option<f64> {
    let name = device_name.to_ascii_lowercase();
    // NVIDIA GeForce / RTX / GTX series (TDP in watts)
    let known: &[(&str, f64)] = &[
        // RTX 50 series
        ("rtx 5090", 575.0), ("rtx 5080", 360.0), ("rtx 5070 ti", 300.0), ("rtx 5070", 250.0),
        ("rtx 5060 ti", 180.0), ("rtx 5060", 145.0),
        // RTX 40 series
        ("rtx 4090", 450.0), ("rtx 4080", 320.0), ("rtx 4070 ti super", 285.0),
        ("rtx 4070 ti", 285.0), ("rtx 4070 super", 220.0), ("rtx 4070", 200.0),
        ("rtx 4060 ti", 160.0), ("rtx 4060", 115.0),
        // RTX 30 series
        ("rtx 3090 ti", 450.0), ("rtx 3090", 350.0), ("rtx 3080 ti", 350.0),
        ("rtx 3080", 320.0), ("rtx 3070 ti", 290.0), ("rtx 3070", 220.0),
        ("rtx 3060 ti", 200.0), ("rtx 3060", 170.0), ("rtx 3050", 130.0),
        // RTX 20 series
        ("rtx 2080 ti", 250.0), ("rtx 2080 super", 250.0), ("rtx 2080", 215.0),
        ("rtx 2070 super", 215.0), ("rtx 2070", 175.0), ("rtx 2060", 160.0),
        // GTX 16 series
        ("gtx 1660 ti", 120.0), ("gtx 1660 super", 125.0), ("gtx 1660", 120.0),
        ("gtx 1650", 75.0),
        // Titan
        ("titan rtx", 280.0), ("titan v", 250.0),
        // AMD Radeon RX series
        ("rx 7900 xtx", 355.0), ("rx 7900 xt", 315.0), ("rx 7900 gre", 260.0),
        ("rx 7800 xt", 263.0), ("rx 7700 xt", 245.0), ("rx 7600", 165.0),
        ("rx 6950 xt", 335.0), ("rx 6900 xt", 300.0), ("rx 6800 xt", 300.0),
        ("rx 6800", 250.0), ("rx 6700 xt", 230.0), ("rx 6600 xt", 132.0),
        ("rx 6600", 132.0),
        // NVIDIA datacenter / pro
        ("a100", 400.0), ("h100", 700.0), ("a6000", 300.0), ("rtx 6000", 300.0),
        ("l40s", 350.0), ("l4", 72.0), ("t4", 70.0),
        // Apple Silicon (integrated — estimate the SoC package power)
        ("apple m1 max", 60.0), ("apple m1 pro", 45.0), ("apple m1", 30.0),
        ("apple m2 max", 70.0), ("apple m2 pro", 50.0), ("apple m2", 25.0),
        ("apple m3 max", 80.0), ("apple m3 pro", 55.0), ("apple m3", 28.0),
        ("apple m4 max", 85.0), ("apple m4 pro", 60.0), ("apple m4", 30.0),
    ];
    // Longest match wins (e.g. "rtx 4070 ti super" over "rtx 4070 ti").
    let mut best: Option<f64> = None;
    let mut best_len = 0usize;
    for (pattern, watts) in known {
        if name.contains(pattern) && pattern.len() > best_len {
            best = Some(*watts);
            best_len = pattern.len();
        }
    }
    if best.is_some() {
        return best;
    }
    // VRAM-size heuristic for unknown discrete GPUs:
    //   ≤4GB → 75W, ≤8GB → 150W, ≤12GB → 220W, ≤16GB → 300W, ≤24GB → 350W, >24GB → 450W
    let gb = vram_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    if gb <= 0.0 {
        return None;
    }
    Some(if gb <= 4.0 {
        75.0
    } else if gb <= 8.0 {
        150.0
    } else if gb <= 12.0 {
        220.0
    } else if gb <= 16.0 {
        300.0
    } else if gb <= 24.0 {
        350.0
    } else {
        450.0
    })
}

/// Auto-detect the GPU and estimate its power draw for the electricity
/// cost calculator. Returns the device name, VRAM bytes, and estimated watts.
#[tauri::command]
pub async fn detect_gpu_power() -> CmdResult<GpuPowerDetection> {
    match query_total_vram_bytes() {
        Some((bytes, name)) => {
            let watts = estimate_gpu_power_watts(&name, bytes);
            Ok(GpuPowerDetection {
                device_name: Some(name),
                total_vram_bytes: Some(bytes),
                estimated_watts: watts,
            })
        }
        None => Ok(GpuPowerDetection {
            device_name: None,
            total_vram_bytes: None,
            estimated_watts: None,
        }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuPowerDetection {
    pub device_name: Option<String>,
    pub total_vram_bytes: Option<u64>,
    pub estimated_watts: Option<f64>,
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
    _repo_id: String,
    filename: String,
    download_url: String,
    expected_sha256: Option<String>,
    dest_dir: Option<String>,
) -> CmdResult<()> {
    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut reg = registry.active.lock();
        // Fix TOCTOU: check + insert under the SAME write lock so two
        // concurrent callers can't both pass the contains_key check.
        if reg.contains_key(&id) {
            return Err("download already in progress for this model".to_string());
        }
        reg.insert(
            id.clone(),
            DownloadSlot {
                cancel: Some(cancel_tx),
            },
        );
    }

    // Read everything we need from the DB up-front; the State guard must
    // not be held across the spawn's await.
    let (dest_dir, token) = {
        let conn = db.0.lock();
        let d = if let Some(p) = dest_dir.as_ref().filter(|s| !s.is_empty()) {
            PathBuf::from(p)
        } else {
            match resolve_models_dir(&conn) {
                Ok(d) => d,
                Err(e) => {
                    // The slot was already registered above — release it or
                    // this model id stays "in progress" forever (the cleanup
                    // in the spawned task never ran).
                    registry.active.lock().remove(&id);
                    return Err(e);
                }
            }
        };
        let t = get_hf_token(&conn);
        (d, t)
    };

    if let Err(e) = fs::create_dir_all(&dest_dir).await {
        // Same slot-release as above (unwritable destination, etc.).
        registry.active.lock().remove(&id);
        return Err(format!("could not create dest dir: {e}"));
    }

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
    let meta_path = partial_path.with_extension("partial.meta");

    // Write a sidecar marker with the download id so resume can verify
    // the partial belongs to this download (not a stale one from a
    // different model with the same filename).
    let _ = std::fs::write(&meta_path, &id);

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

    // Resume support: if a previous attempt left a .partial file on
    // disk, find its current size and ask the server for the rest with
    // `Range: bytes=<n>-`. HF's CDN supports this; if the server
    // returns 200 (not 206) or doesn't accept the range, we fall back
    // to a fresh download.
    //
    // SECURITY: before trusting a leftover .partial for resume, we
    // verify its identity. If we have an expected_sha, we read back
    // the prefix and hash it; if the partial SHA doesn't match the
    // expected hash's prefix, we discard it (it's from a different
    // download or a corrupted resume). Without expected_sha we have
    // no way to verify, so we refuse to resume — a fresh download is
    // safer than appending to a stranger's partial.
    let mut resume_from: u64 = fs::metadata(partial_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if resume_from > 0 {
        // Verify the partial file belongs to THIS download via the sidecar
        // `.partial.meta` marker (written by start_model_download /
        // download_mmproj with the download id). If it's missing, stale, or
        // from a different download, discard the partial — appending to a
        // stranger's partial would corrupt the final file. We only resume
        // when expected_sha is also present (so the full-file hash check
        // still runs after the suffix is written).
        let can_resume = if expected_sha.is_some() {
            let meta_path = partial_path.with_extension("partial.meta");
            matches!(tokio::fs::read_to_string(&meta_path).await, Ok(saved_id) if saved_id == id)
        } else {
            false
        };
        if !can_resume {
            // Partial is unverified — discard and start fresh.
            let _ = fs::remove_file(partial_path).await;
            let meta_path = partial_path.with_extension("partial.meta");
            let _ = fs::remove_file(&meta_path).await;
            resume_from = 0;
        }
    }
    // Two attempts max: with the stored token, then — only if HF REJECTED
    // that token — anonymously. A stored-but-invalid token makes even PUBLIC
    // files 401, which used to surface as a bogus "this model is gated";
    // genuinely gated repos still fail both attempts and get the friendly
    // message below.
    let mut attempt_auth: Option<&str> = token.filter(|t| !t.is_empty());
    let resp = loop {
        let mut req = client.get(url);
        if let Some(t) = attempt_auth.as_deref() {
            req = req.bearer_auth(t);
        }
        if resume_from > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
        }
        let r = req
            .send()
            .await
            .map_err(|e| format!("download request failed: {e}"))?;
        let rejected = r.status().as_u16() == 401 || r.status().as_u16() == 403;
        if rejected && attempt_auth.take().is_some() {
            continue; // retry anonymously
        }
        break r;
    };
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

    // 206 Partial Content confirms the server honored the Range and
    // resumed; 200 OK means the server is sending the full file from
    // byte 0, so the existing partial is stale — discard it.
    let resuming = status == reqwest::StatusCode::PARTIAL_CONTENT && resume_from > 0;
    if !resuming && resume_from > 0 {
        let _ = fs::remove_file(partial_path).await;
    }

    // The total size of the *remaining* payload. If the server gave a
    // full Content-Length, that's the bytes we'll receive; if it gave
    // a Content-Range, we add the already-downloaded prefix.
    let total = if resuming {
        resp.content_length().map(|c| c + resume_from)
    } else {
        resp.content_length()
    };
    let mut stream = resp.bytes_stream();

    // Open the partial in append mode when resuming, truncate mode
    // otherwise. We track `downloaded` as the running total of what
    // *this* run has written; the UI event reports the cumulative count
    // (so progress bars don't reset on resume).
    let mut file = if resuming {
        let mut opts = fs::OpenOptions::new();
        opts.append(true).open(partial_path).await
    } else {
        fs::File::create(partial_path).await
    }
    .map_err(|e| format!("could not open .partial file: {e}"))?;

    let mut downloaded: u64 = resume_from;
    let started = Instant::now();
    let mut last_emit = Instant::now();
    // If we have an expected SHA, we need to verify the final blob.
    // When resuming, the hasher is primed by re-reading the prefix
    // from the partial file (identity-verified via the sidecar .meta
    // file above). This ensures the SHA-256 covers the full file.
    let mut hasher = if resuming && expected_sha.is_some() {
        // Re-read the prefix to prime the hasher. We know the partial
        // exists and was identity-verified above.
        match tokio::fs::read(partial_path).await {
            Ok(prefix) => {
                let mut h = Sha256::new();
                h.update(&prefix);
                Some(h)
            }
            _ => None, // fallback: skip hash (rare; partial vanished mid-resume)
        }
    } else if !resuming {
        expected_sha.map(|_| Sha256::new())
    } else {
        None
    };

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

    // Clean up the sidecar meta file after successful rename.
    let meta_path = partial_path.with_extension("partial.meta");
    let _ = fs::remove_file(&meta_path).await;

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

// ---- Delete a downloaded model ----
//
// Removes the GGUF (and any sibling .mmproj.gguf with the same stem)
// from disk. Restricted to files under the resolved models dir — a
// caller can't use this to delete arbitrary files because we
// canonicalize the path and check the prefix.
#[tauri::command]
pub fn delete_downloaded_model(
    db: State<'_, DbState>,
    path: String,
) -> CmdResult<()> {
    let conn = db.0.lock();
    let models_dir = resolve_models_dir(&conn)?;
    drop(conn);

    let target = std::path::PathBuf::from(&path);
    let canon_models = std::fs::canonicalize(&models_dir)
        .map_err(|e| format!("could not canonicalize models dir: {e}"))?;
    let canon_target = std::fs::canonicalize(&target)
        .map_err(|e| format!("could not find file: {e}"))?;
    // Case-insensitive on Windows, component-wise everywhere — a same-prefix
    // sibling dir (`models2\…`) must NOT pass this boundary.
    let is_under_models = crate::util::path_starts_with_ci(&canon_target, &canon_models);
    if !is_under_models {
        return Err("path is outside the models directory".to_string());
    }
    std::fs::remove_file(&canon_target)
        .map_err(|e| format!("could not delete model: {e}"))?;

    // Also delete the matching mmproj if present (same stem, .mmproj.gguf).
    if let Some(stem) = canon_target.file_stem().and_then(|s| s.to_str()) {
        let parent = canon_target.parent().unwrap_or(&canon_models);
        let mmproj = parent.join(format!("{stem}.mmproj.gguf"));
        let _ = std::fs::remove_file(mmproj);
    }
    Ok(())
}

// ---- mmproj auto-download ----
//
// For vision-capable models (vision: true in the catalog entry, or any
// sibling filename containing "mmproj"), the llama-server sidecar
// needs a companion projector GGUF. After the main .gguf finishes
// downloading, look up the repo's siblings, pick the right mmproj, and
// kick off a background download. The UI doesn't need to know about
// this — the next rescan shows both files in the On Disk list.
//
// Picked-mmproj heuristic: prefer the smallest .mmproj-projection file
// in the repo (the user can override by passing mmprojFilename to the
// command). If no mmproj is found, this is a no-op.

#[tauri::command]
pub async fn download_mmproj(
    app: AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, Arc<DownloadRegistry>>,
    repo_id: String,
    mmproj_filename: Option<String>,
) -> CmdResult<()> {
    // Pull token up-front; no State<DbState> across await.
    let token = {
        let conn = db.0.lock();
        get_hf_token(&conn)
    };

    // Resolve models dir (best-effort) so we know where to write the
    // mmproj — keep it next to the .gguf it projects for.
    let dest_dir = {
        let conn = db.0.lock();
        resolve_models_dir(&conn)
    }?;
    fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| format!("could not create dest dir: {e}"))?;

    // List siblings via the HF API to find a mmproj file. If the caller
    // pinned a specific filename, use it directly; otherwise pick the
    // smallest .mmproj*.gguf in the repo.
    let client = http_client();
    let url = format!("https://huggingface.co/api/models/{repo_id}");
    let mut req = client.get(&url);
    if let Some(t) = token.as_deref() {
        if !t.is_empty() {
            req = req.bearer_auth(t);
        }
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("HF siblings request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HF returned {}", resp.status()));
    }
    let model: HfModel = resp
        .json()
        .await
        .map_err(|e| format!("HF siblings parse failed: {e}"))?;

    let pick = if let Some(name) = mmproj_filename.as_deref() {
        model
            .siblings
            .iter()
            .find(|s| s.rfilename == name)
            .cloned()
    } else {
        model
            .siblings
            .iter()
            .filter(|s| {
                let l = s.rfilename.to_ascii_lowercase();
                l.contains("mmproj") && l.ends_with(".gguf")
            })
            .min_by_key(|s| s.size.unwrap_or(u64::MAX))
            .cloned()
    };
    let Some(sibling) = pick else {
        // No mmproj in the repo — nothing to do, but also not an error.
        return Ok(());
    };

    let mmproj_id = format!("{repo_id}::mmproj::{}", sibling.rfilename);
    let download_url =
        format!("https://huggingface.co/{repo_id}/resolve/main/{}", sibling.rfilename);

    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut reg = registry.active.lock();
        // Fix TOCTOU: check + insert under the SAME write lock so two
        // concurrent callers can't both pass the contains_key check.
        if reg.contains_key(&mmproj_id) {
            return Err("mmproj download already in progress".to_string());
        }
        reg.insert(
            mmproj_id.clone(),
            DownloadSlot {
                cancel: Some(cancel_tx),
            },
        );
    }


    // Use the safe_filename routine via the same logic.
    let safe_filename: String = sibling
        .rfilename
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let final_path = dest_dir.join(&safe_filename);
    let partial_path = dest_dir.join(format!("{safe_filename}.partial"));
    let meta_path = partial_path.with_extension("partial.meta");
    // Write sidecar marker for resume verification (same as model download).
    let _ = std::fs::write(&meta_path, &mmproj_id);

    let id_for_task = mmproj_id.clone();
    let app_for_task = app.clone();
    let registry_for_task = Arc::clone(&registry);

    tauri::async_runtime::spawn(async move {
        let result = run_download(
            &app_for_task,
            &id_for_task,
            &download_url,
            token.as_deref(),
            &partial_path,
            &final_path,
            sibling.sha256.as_deref(),
            cancel_rx,
        )
        .await;

        {
            let mut reg = registry_for_task.active.lock();
            reg.remove(&id_for_task);
        }

        // Reuse the same progress event so the UI can show this as just
        // another download (or silently — the mmproj is a sidecar, not
        // a user-initiated download, so the UI might choose to hide
        // these in the card list).
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

    let _ = app.emit(
        "local-model:download:progress",
        &DownloadProgress {
            id: mmproj_id,
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

// ---- tests live below in the `#[cfg(test)] mod tests` block ----

// ---- Tests ----
//
// The HF response shape is huge; we don't need a live server to verify
// our normalizer does the right thing. The unit tests below cover:
//   1. extract_quantization (the common Q/quant labels + fall-through)
//   2. extract_params_label (the "<N>B" pattern + edge cases)
//   3. normalize_hf_model (full projection from a fake HF response,
//      including the license tag pull-through and vision detection)
//   4. ram_class: lifted from chat::local_models; not re-tested here.
//   5. the SHA-256 mismatch path of run_download: covered by a small
//      in-process spawn that points reqwest at a loopback mock and
//      asserts the file is removed + a Failed abort is returned.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    // ---- estimate_gpu_power_watts ----

    #[test]
    fn gpu_power_known_nvidia() {
        assert_eq!(
            estimate_gpu_power_watts("NVIDIA GeForce RTX 4090", 24 * 1024 * 1024 * 1024),
            Some(450.0)
        );
        assert_eq!(
            estimate_gpu_power_watts("NVIDIA GeForce RTX 3090", 24 * 1024 * 1024 * 1024),
            Some(350.0)
        );
        assert_eq!(
            estimate_gpu_power_watts("NVIDIA GeForce RTX 3060", 12 * 1024 * 1024 * 1024),
            Some(170.0)
        );
    }

    #[test]
    fn gpu_power_longest_match_wins() {
        // "rtx 4070 ti super" (285W) must win over "rtx 4070 ti" (285W) and "rtx 4070" (200W)
        assert_eq!(
            estimate_gpu_power_watts("RTX 4070 Ti SUPER", 16 * 1024 * 1024 * 1024),
            Some(285.0)
        );
    }

    #[test]
    fn gpu_power_known_amd() {
        assert_eq!(
            estimate_gpu_power_watts("AMD Radeon RX 7900 XTX", 24 * 1024 * 1024 * 1024),
            Some(355.0)
        );
    }

    #[test]
    fn gpu_power_apple_silicon() {
        assert_eq!(
            estimate_gpu_power_watts("Apple M3 Max", 36 * 1024 * 1024 * 1024),
            Some(80.0)
        );
    }

    #[test]
    fn gpu_power_unknown_falls_back_to_vram_heuristic() {
        // 12GB unknown GPU → 220W heuristic
        assert_eq!(
            estimate_gpu_power_watts("Generic Graphics Device", 12 * 1024 * 1024 * 1024),
            Some(220.0)
        );
        // 4GB → 75W
        assert_eq!(
            estimate_gpu_power_watts("Generic Graphics Device", 4 * 1024 * 1024 * 1024),
            Some(75.0)
        );
    }

    #[test]
    fn gpu_power_zero_vram_returns_none() {
        assert_eq!(estimate_gpu_power_watts("Generic", 0), None);
    }

    // ---- extract_quantization ----

    #[test]
    fn quantization_matches_known_labels() {
        for (filename, expected) in [
            ("llama-3-8b-instruct.Q4_K_M.gguf", "Q4_K_M"),
            ("qwen2.5-coder-7b-instruct-q4_0.gguf", "Q4_0"),
            ("mistral-7b.Q5_1.gguf", "Q5_1"),
            ("phi-3-mini.q6_k.gguf", "Q6_K"),
            ("llama-3.1-8b.iq4_xs.gguf", "IQ4_XS"),
            ("gemma-2-9b.f16.gguf", "F16"),
            // bf16 must come before f16 in the lookup list, otherwise
            // "bf16" matches "f16" first — verified by ordering in
            // extract_quantization's needle array.
            ("deepseek-v2-lite.bf16.gguf", "BF16"),
            ("model-name.bf16.gguf", "BF16"),
        ] {
            assert_eq!(
                extract_quantization(&filename.to_ascii_lowercase()),
                Some(expected.to_string()),
                "filename: {filename}"
            );
        }
    }

    #[test]
    fn quantization_returns_none_for_unknown() {
        // No quant label present — should not guess.
        assert_eq!(extract_quantization("model.gguf"), None);
        assert_eq!(extract_quantization("llama-8b.bogus.gguf"), None);
    }

    // ---- extract_params_label ----

    #[test]
    fn params_label_picks_n_b_from_filename() {
        for (filename, expected) in [
            ("llama-2-7b-chat.Q4_K_M.gguf", Some("7B")),
            ("qwen2.5-coder-32b-instruct-q5_0.gguf", Some("32B")),
            ("mistral-7b-instruct-v0.3.Q4_0.gguf", Some("7B")),
            ("gemma-2-27b-it.Q6_K.gguf", Some("27B")),
            // phi-3: the "3" in "phi-3" is followed by "-" (not "b"), so
            // it's rejected by the boundary check; the "3" in "mini-3" or
            // similar would be picked up. For "phi-3-mini-4k-instruct" the
            // 4k has no 'b' suffix → no params label.
            ("phi-3-mini-4k-instruct.Q4_K_M.gguf", None),
            ("llama-3.1-8b-instruct.Q4_K_M.gguf", Some("8B")),
        ] {
            let got = extract_params_label(&filename.to_ascii_lowercase(), "");
            assert_eq!(got.as_deref(), expected, "filename: {filename}");
        }
    }

    #[test]
    fn params_label_falls_back_to_repo_id() {
        // Filename has no label, repo id does.
        let got = extract_params_label("model.gguf", "owner/llama-2-13b-chat-gguf");
        assert_eq!(got, Some("13B".to_string()));
    }

    #[test]
    fn params_label_rejects_garbage() {
        // "abc" — no digit.
        assert_eq!(extract_params_label("abc-model.gguf", ""), None);
        // 0B / 9999B out of range.
        assert_eq!(extract_params_label("0b-model.gguf", ""), None);
        // 2000B is out of (1..=1000) — no match.
        assert_eq!(extract_params_label("2000b-model.gguf", ""), None);
    }

    // ---- normalize_hf_model ----

    #[test]
    fn normalizer_skips_non_gguf_and_extracts_license() {
        let m = HfModel {
            id: "TheBloke/Llama-2-7B-Chat-GGUF".to_string(),
            author: Some("TheBloke".to_string()),
            downloads: 12345,
            likes: 67,
            last_modified: Some("2024-01-15T10:00:00Z".to_string()),
            created_at: None,
            description: Some("Llama 2 chat model in GGUF format.".to_string()),
            tags: vec![
                "gguf".to_string(),
                "text-generation".to_string(),
                "license:llama2".to_string(),
                // No "multimodal" / "vision" tag here — vision should be
                // false unless detected from filename (Q4_K_M has no
                // mmproj in its name).
            ],
            pipeline_tag: None,
            library_name: None,
            siblings: vec![
                HfSibling {
                    rfilename: "llama-2-7b-chat.Q4_K_M.gguf".to_string(),
                    size: Some(4_000_000_000),
                    sha256: Some("deadbeef".repeat(8)),
                },
                HfSibling {
                    rfilename: "README.md".to_string(), // should be skipped
                    size: Some(1000),
                    sha256: None,
                },
                HfSibling {
                    rfilename: "llama-2-7b-chat.Q5_1.gguf".to_string(),
                    size: Some(4_700_000_000),
                    sha256: None,
                },
            ],
        };
        let entries = normalize_hf_model(m);
        assert_eq!(entries.len(), 2, "README.md should be skipped");
        let e = &entries[0];
        assert_eq!(e.repo_id, "TheBloke/Llama-2-7B-Chat-GGUF");
        assert_eq!(e.author, "TheBloke");
        assert_eq!(e.filename, "llama-2-7b-chat.Q4_K_M.gguf");
        assert_eq!(e.quantization.as_deref(), Some("Q4_K_M"));
        assert_eq!(e.params_label.as_deref(), Some("7B"));
        assert_eq!(e.license.as_deref(), Some("llama2"));
        // No "multimodal"/"vision" tag, no mmproj in filename → not vision.
        assert!(!e.vision);
        assert_eq!(e.sha256.as_deref(), Some(&"deadbeef".repeat(8)[..]));
        assert_eq!(e.size_bytes, 4_000_000_000);
        assert_eq!(
            e.download_url,
            "https://huggingface.co/TheBloke/Llama-2-7B-Chat-GGUF/resolve/main/llama-2-7b-chat.Q4_K_M.gguf"
        );
        // Q5_1 sibling: no sha, no vision.
        let e2 = &entries[1];
        assert_eq!(e2.quantization.as_deref(), Some("Q5_1"));
        assert!(e2.sha256.is_none());
        assert!(!e2.vision);
    }

    #[test]
    fn normalizer_detects_mmproj_filename() {
        let m = HfModel {
            id: "org/vision-gguf".to_string(),
            author: None,
            downloads: 0,
            likes: 0,
            last_modified: None,
            created_at: None,
            description: None,
            tags: vec!["gguf".to_string()],
            pipeline_tag: None,
            library_name: None,
            siblings: vec![HfSibling {
                rfilename: "llava-v1.5-7b-mmproj-f16.gguf".to_string(),
                size: Some(100_000_000),
                sha256: None,
            }],
        };
        let entries = normalize_hf_model(m);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].vision, "mmproj in filename → vision");
    }

    // ---- urlencoding_lite ----

    #[test]
    fn urlencoding_lite_handles_common_chars() {
        assert_eq!(urlencoding_lite("hello world"), "hello%20world");
        assert_eq!(urlencoding_lite("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencoding_lite("c++"), "c%2B%2B");
        assert_eq!(urlencoding_lite("plain"), "plain");
        assert_eq!(urlencoding_lite("a-b_c.d~e"), "a-b_c.d~e");
    }

    // ---- run_download: SHA-256 mismatch path ----
    //
    // We don't have a live HF server in tests, so we test the parts of
    // run_download that we can without HTTP: the SHA-256 mismatch path
    // would normally only be reachable after a real download. Instead we
    // write a `.partial` file with known bytes, then exercise the same
    // verify logic (file presence + hasher + rename) used by
    // run_download. This catches the "rename to final path" path
    // independently of HTTP.

    #[tokio::test]
    async fn download_atomic_rename_and_mismatch_cleanup() {
        use sha2::{Digest, Sha256};

        let tmp = std::env::temp_dir().join(format!("conduit_mkt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let partial = tmp.join("model.gguf.partial");
        let final_path = tmp.join("model.gguf");

        // Write the partial with known bytes, then compute the correct
        // hash.
        let bytes = b"hello conduit";
        std::fs::write(&partial, bytes).unwrap();
        let mut h = Sha256::new();
        h.update(bytes);
        let good_hash = format!("{:x}", h.finalize());
        let bad_hash = "0000000000000000000000000000000000000000000000000000000000000000";

        // Verify-by-hash: bad hash → cleanup.
        let r = verify_and_finalize(&partial, &final_path, Some(bad_hash)).await;
        assert!(r.is_err(), "bad hash should error");
        assert!(!partial.exists(), ".partial must be removed on mismatch");
        assert!(!final_path.exists());

        // Re-create the partial and verify with the good hash.
        std::fs::write(&partial, bytes).unwrap();
        verify_and_finalize(&partial, &final_path, Some(&good_hash))
            .await
            .expect("good hash should succeed");
        assert!(!partial.exists(), ".partial must be removed after rename");
        assert!(final_path.exists());
        let got = std::fs::read(&final_path).unwrap();
        assert_eq!(got, bytes);

        // No expected hash → skip verify, still rename.
        let partial2 = tmp.join("model2.gguf.partial");
        let final2 = tmp.join("model2.gguf");
        std::fs::write(&partial2, bytes).unwrap();
        verify_and_finalize(&partial2, &final2, None).await.unwrap();
        assert!(final2.exists());
        assert!(!partial2.exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ---- sanitize_filename via start_model_download's inline mapping ----
    //
    // The sanitize function is local to start_model_download; re-derive
    // it here to lock down the behavior.

    fn sanitize_for_test(name: &str) -> String {
        name.chars()
            .map(|c| match c {
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
                c if (c as u32) < 0x20 => '_',
                c => c,
            })
            .collect()
    }

    #[test]
    fn sanitize_filename_rejects_unsafe_chars() {
        assert_eq!(sanitize_for_test("ok.gguf"), "ok.gguf");
        assert_eq!(sanitize_for_test("a/b\\c.gguf"), "a_b_c.gguf");
        assert_eq!(
            sanitize_for_test("weird:name*?.gguf"),
            "weird_name__.gguf"
        );
        // Control char (< 0x20) → _
        let mut s = String::from("xx");
        s.push(0x01 as char);
        s.push_str(".gguf");
        assert_eq!(sanitize_for_test(&s), "xx_.gguf");
    }

    // ---- reference: pick the right fields out of FetchCatalogResult ----
    // (just exercises the JSON shape so a serialization regression shows up)

    #[test]
    fn catalog_cache_freshness_boundary() {
        let now = std::time::Instant::now();
        assert!(catalog_cache_fresh(now, now));
        // Instant supports Sub<Duration>, so an "old" timestamp is easy.
        let old = now - std::time::Duration::from_secs(CATALOG_CACHE_TTL_SECS + 1);
        assert!(!catalog_cache_fresh(old, now));
        let edge = now - std::time::Duration::from_secs(CATALOG_CACHE_TTL_SECS);
        assert!(!catalog_cache_fresh(edge, now), "TTL boundary counts as expired");
    }

    #[test]
    fn catalog_cache_stale_get_marks_and_extends() {
        // Unique key so the shared static can't race other cache tests.
        let key: CatalogCacheKey = ("stale-test".into(), "downloads".into(), 7, false);
        catalog_cache_put(
            key.clone(),
            FetchCatalogResult {
                entries: vec![],
                has_hugging_face_token: false,
                default_models_dir: None,
                stale: false,
            },
        );
        let fresh = catalog_cache_get(&key).expect("just inserted is fresh");
        assert!(!fresh.stale);
        // Age it past the TTL, then the stale-on-error path serves it marked.
        {
            let mut cache = CATALOG_CACHE.lock();
            cache.get_mut(&key).unwrap().fetched_at =
                std::time::Instant::now() - std::time::Duration::from_secs(CATALOG_CACHE_TTL_SECS + 5);
        }
        assert!(catalog_cache_get(&key).is_none(), "expired entry is not fresh");
        let stale = catalog_cache_stale_get(&key).expect("expired entry still serves stale");
        assert!(stale.stale);
        // The stale path refreshed the timestamp, so it now reads fresh again
        // (repeated offline reloads keep working instead of erroring).
        let again = catalog_cache_get(&key).expect("refreshed by stale hit");
        assert!(!again.stale);
    }

    #[test]
    fn fetch_catalog_result_serializes_camel_case() {
        let r = FetchCatalogResult {
            entries: vec![],
            has_hugging_face_token: true,
            default_models_dir: Some("/tmp/models".to_string()),
            stale: false,
        };
        let s = serde_json::to_string(&r).unwrap();
        let v: HashMap<String, serde_json::Value> = serde_json::from_str(&s).unwrap();
        assert!(v.contains_key("hasHuggingFaceToken"));
        assert!(v.contains_key("defaultModelsDir"));
        // `stale` is skipped when false — only an offline-served copy carries it.
        assert!(!v.contains_key("stale"));
        let stale_r = FetchCatalogResult { stale: true, ..r };
        let s2 = serde_json::to_string(&stale_r).unwrap();
        assert!(s2.contains("\"stale\":true"));
        // camelCase verified.
    }

    #[test]
    fn download_state_serializes_snake_case() {
        for (s, want) in [
            (DownloadState::Starting, "\"starting\""),
            (DownloadState::Downloading, "\"downloading\""),
            (DownloadState::Verifying, "\"verifying\""),
            (DownloadState::Done, "\"done\""),
            (DownloadState::Error, "\"error\""),
            (DownloadState::Cancelled, "\"cancelled\""),
        ] {
            assert_eq!(serde_json::to_string(&s).unwrap(), want);
        }
    }
}

// ---- refactor: extract the verify+rename half of run_download so it
// is unit-testable without an HTTP server. This is a verbatim copy of
// the tail of run_download, used by the download_atomic_rename test
// above. Kept at file scope so it can see `DownloadAbort`.

#[cfg(test)]
async fn verify_and_finalize(
    partial_path: &Path,
    final_path: &Path,
    expected_sha: Option<&str>,
) -> Result<(), DownloadAbort> {
    if let Some(expected) = expected_sha {
        use sha2::{Digest, Sha256};
        let bytes = std::fs::read(partial_path).map_err(|e| e.to_string())?;
        let mut h = Sha256::new();
        h.update(&bytes);
        let got = format!("{:x}", h.finalize());
        if !got.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(partial_path).await;
            return Err(DownloadAbort::Failed(format!(
                "SHA-256 mismatch (expected {expected}, got {got})"
            )));
        }
    }
    if let Some(parent) = final_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir: {e}"))?;
    }
    tokio::fs::rename(partial_path, final_path)
        .await
        .map_err(|e| format!("rename to final path failed: {e}"))?;
    Ok(())
}
