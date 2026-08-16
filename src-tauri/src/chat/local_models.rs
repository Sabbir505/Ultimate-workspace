//! Local-model sidecar: scan folders for .gguf files, parse GGUF metadata,
//! memory-sanity check, and spawn/stop llama-server as an OpenAI-compatible
//! endpoint on a local port.
//!
//! The registry is keyed by model_id so N sidecars could run concurrently,
//! though the v1 policy stops any existing sidecar before starting a new one.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

// ---- GGUF scanner types ----

#[derive(Debug, Clone)]
pub struct GgufMeta {
    pub name: Option<String>,
    pub architecture: Option<String>,
    pub param_count_label: Option<String>,
    pub quantization: Option<String>,
}

/// Architectures that only make sense as embedding models (served with
/// llama-server's `--embedding` flag). Used both to keep embedding GGUFs out
/// of the chat-model picker and to find the corpus embedder on disk.
pub fn is_embedding_arch(arch: &str) -> bool {
    matches!(
        arch,
        "bert" | "nomic-bert" | "jina-bert-v2" | "jina-bert-v3" | "roberta" | "xlm-roberta"
    )
}

#[derive(Debug, Clone)]
pub struct GgufFile {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub size_bytes: u64,
    pub meta: GgufMeta,
    pub source: String,
    /// Whether a companion mmproj (vision projector / CLIP encoder) GGUF was
    /// found next to this model. When set, the sidecar is started with
    /// `--mmproj <path>` so vision-capable architectures (Gemma 3, LLaVA, …)
    /// can accept image inputs.
    pub has_vision: bool,
    /// Absolute path to the companion mmproj GGUF, if found.
    pub mmproj_path: Option<String>,
}

// ---- Memory sanity ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryClass {
    Fits,
    Tight,
    TooLarge,
}

impl MemoryClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemoryClass::Fits => "fits",
            MemoryClass::Tight => "tight",
            MemoryClass::TooLarge => "too_large",
        }
    }
}

/// Conservative heuristic: <50% RAM = fits, 50-80% = tight, >80% = too-large.
/// The gap accounts for context/KV-cache overhead that can easily double the
/// in-memory footprint of a loaded model.
pub fn memory_class(file_size_bytes: u64, total_ram_bytes: u64) -> MemoryClass {
    if total_ram_bytes == 0 {
        return MemoryClass::Tight;
    }
    let ratio = file_size_bytes as f64 / total_ram_bytes as f64;
    if ratio < 0.5 {
        MemoryClass::Fits
    } else if ratio < 0.8 {
        MemoryClass::Tight
    } else {
        MemoryClass::TooLarge
    }
}

// ---- GGUF metadata parser ----

/// Minimal GGUF header parser. Read-only: extracts metadata KV pairs and
/// returns the most useful fields. Tolerant — never panics on a bad file.
pub fn parse_gguf(path: &Path) -> GgufMeta {
    let mut meta = GgufMeta {
        name: None,
        architecture: None,
        param_count_label: None,
        quantization: None,
    };

    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return meta,
    };

    // Read magic + version + counts.
    let mut header = [0u8; 4 + 4 + 8 + 8];
    if file.read_exact(&mut header).is_err() {
        return meta;
    }

    // Magic: "GGUF" = 0x47 0x47 0x55 0x46
    let magic = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    if magic != 0x46554747 {
        return meta; // not a GGUF file
    }

    let _version = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    let _tensor_count = u64::from_le_bytes([
        header[8], header[9], header[10], header[11],
        header[12], header[13], header[14], header[15],
    ]);
    let metadata_kv_count = u64::from_le_bytes([
        header[16], header[17], header[18], header[19],
        header[20], header[21], header[22], header[23],
    ]);

    // Read KV pairs.
    let mut kv = HashMap::new();
    for _ in 0..metadata_kv_count.min(1024) {
        // string key: u64 length + utf8
        let key = match read_gguf_string(&mut file) {
            Ok(k) => k,
            Err(_) => break,
        };
        // value type: u32
        let mut type_buf = [0u8; 4];
        if file.read_exact(&mut type_buf).is_err() {
            break;
        }
        let value_type = u32::from_le_bytes(type_buf);
        // value
        match value_type {
            // GGUFValueType: string = 8
            8 => {
                if let Ok(val) = read_gguf_string(&mut file) {
                    kv.insert(key, val);
                }
            }
            // array = 9 -> skip (type + count + items)
            9 => {
                // Per the GGUF spec an array value is u32 element-type + u64
                // element-count. Reading count as u32 leaves the high half in
                // the stream and desyncs EVERY KV pair after the first array
                // (tokenizer arrays are ubiquitous), so metadata positioned
                // after an array parsed as garbage.
                let mut arr_header = [0u8; 4 + 8]; // type (u32) + count (u64)
                if file.read_exact(&mut arr_header).is_ok() {
                    let _arr_type = u32::from_le_bytes([arr_header[0], arr_header[1], arr_header[2], arr_header[3]]);
                    let arr_count = u64::from_le_bytes([
                        arr_header[4], arr_header[5], arr_header[6], arr_header[7],
                        arr_header[8], arr_header[9], arr_header[10], arr_header[11],
                    ]);
                    // Skip the array payload. Since we only care about string KV values,
                    // and arrays are metadata blobs (tokenizer, etc.), skip them.
                    skip_gguf_value(&mut file, _arr_type, arr_count);
                }
            }
            // Everything else: scalar (bool=1, uint8=2, int8=3, uint16=4,
            // int16=5, uint32=6, int32=7, uint64=10, int64=11, float32=12,
            // float64=13). Size is fixed per type — skip it.
            _ => {
                let scalar_size = gguf_scalar_size(value_type);
                if scalar_size > 0 {
                    let mut skip = vec![0u8; scalar_size];
                    let _ = file.read_exact(&mut skip);
                }
            }
        }
    }

    meta.name = kv.remove("general.name");
    meta.architecture = kv.remove("general.architecture");
    meta.param_count_label = kv.remove("general.size_label");
    // Try a few common quantization key names.
    meta.quantization = kv
        .remove("general.file_type")
        .or_else(|| kv.remove("general.quantization_version"))
        .or_else(|| kv.remove("tokenizer.ggml.type"));

    meta
}

fn read_gguf_string(file: &mut fs::File) -> Result<String, std::io::Error> {
    let mut len_buf = [0u8; 8];
    file.read_exact(&mut len_buf)?;
    let len = u64::from_le_bytes(len_buf) as usize;
    // Safety cap: strings over 64 KiB are suspicious.
    if len > 65536 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "gguf string too long"));
    }
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

fn gguf_scalar_size(value_type: u32) -> usize {
    match value_type {
        1 => 1,  // bool
        2 | 3 => 1, // uint8 / int8
        4 | 5 => 2, // uint16 / int16
        6 | 7 => 4, // uint32 / int32
        8 => 0,  // string (handled separately)
        9 => 0,  // array (handled separately)
        10 | 11 => 8, // uint64 / int64
        12 => 4, // float32
        13 => 8, // float64
        _ => 0,
    }
}

fn skip_gguf_value(file: &mut fs::File, value_type: u32, count: u64) {
    if count == 0 {
        return;
    }
    if value_type == 8 {
        // Array of strings: skip each string.
        for _ in 0..count.min(256) {
            let _ = read_gguf_string(file);
        }
    } else {
        let size = gguf_scalar_size(value_type);
        let total = (size as u64).saturating_mul(count).min(1024 * 1024);
        let mut buf = vec![0u8; total as usize];
        let _ = file.read_exact(&mut buf);
    }
}

// ---- Scanner ----

/// Quick GGUF magic check — reads just the 4-byte header. Used for candidate
/// files that don't carry a `.gguf` extension (Ollama blobs are named
/// `sha256-<digest>` with no extension at all).
fn has_gguf_magic(path: &Path) -> bool {
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut magic = [0u8; 4];
    if file.read_exact(&mut magic).is_err() {
        return false;
    }
    u32::from_le_bytes(magic) == 0x46554747 // "GGUF"
}

/// Recursively scan a directory for `.gguf` files.
///
/// When `source` is `"ollama"` the extension filter is relaxed: blob files
/// have no extension, so any file whose header carries the GGUF magic is a
/// candidate (the metadata parser still rejects non-GGUF content).
pub fn scan_folder(dir: &Path, source: &str) -> Vec<GgufFile> {
    let mut files = Vec::new();
    // filter_map(ok) — NOT collect::<Result<..>>: a single unreadable entry
    // (permission-denied subdir, dangling junction — common in Downloads and
    // drive roots) must skip, not abort the whole scan with zero models found.
    let walker: Vec<_> = walkdir::WalkDir::new(dir)
        .max_depth(6)
        .into_iter()
        .filter_map(|e| e.ok())
        .collect();

    let extensionless_ok = source == "ollama";

    // First pass: collect all .gguf paths, then pair mmproj files with their
    // companion model. The mmproj file usually lives in the same directory as
    // the model with a predictable name (mmproj-<model>.gguf or mmproj.gguf).
    let mut model_files: Vec<(walkdir::DirEntry, GgufMeta)> = Vec::new();
    let mut mmproj_paths: std::collections::HashMap<String, PathBuf> = std::collections::HashMap::new();

    for entry in walker {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !name.ends_with(".gguf") {
            // Ollama blobs have no extension — fall back to the magic check.
            if !(extensionless_ok && has_gguf_magic(entry.path())) {
                continue;
            }
        }
        let path = entry.path();
        let meta = parse_gguf(path);

        // Detect vision-projector companion files (mmproj-*.gguf or mmproj.gguf).
        // These are CLIP vision encoders that llama-server loads via --mmproj.
        // We store them keyed by directory so models in the same dir can find
        // their companion.
        if name.starts_with("mmproj") || matches!(meta.architecture.as_deref(), Some("clip")) {
            let dir_key = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            mmproj_paths.insert(dir_key, path.to_path_buf());
            continue;
        }

        // Skip non-chat architectures that slipped through (mmproj caught above).
        if matches!(meta.architecture.as_deref(), Some("mmproj")) {
            continue;
        }

        // Embedding models (nomic-embed-text etc. — the local-RAG corpus
        // embedder) are not chat models: they only work with llama-server's
        // --embedding flag and would fail to chat. Keep them out of the chat
        // picker; the Knowledge panel resolves them via is_embedding_arch.
        if meta
            .architecture
            .as_deref()
            .is_some_and(is_embedding_arch)
        {
            continue;
        }

        model_files.push((entry, meta));
    }

    // Second pass: build GgufFile entries, attaching the mmproj companion when
    // one was found in the same directory.
    for (entry, meta) in model_files {
        let path = entry.path();
        let dir_key = path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let (has_vision, mmproj_path) = if let Some(mp) = mmproj_paths.get(&dir_key) {
            (true, Some(mp.to_string_lossy().to_string()))
        } else {
            (false, None)
        };

        let meta_info = match path.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size_bytes = meta_info.len();
        let full_path = path.to_string_lossy().to_string();
        files.push(GgufFile {
            id: full_path.clone(),
            path: full_path,
            filename: entry.file_name().to_string_lossy().to_string(),
            size_bytes,
            meta,
            source: source.to_string(),
            has_vision,
            mmproj_path,
        });
    }
    files
}

/// Scan the default locations where GGUF files commonly live.
pub fn scan_default_locations() -> Vec<GgufFile> {
    let mut all = Vec::new();

    // LM Studio cache (Unix-style path inside home).
    if let Some(home) = dirs::home_dir() {
        let lm_studio = home.join(".cache").join("lm-studio").join("models");
        all.extend(scan_folder(&lm_studio, "lm-studio"));
    }

    // LM Studio cache (new-style path, LM Studio ≥0.3 — the layout current
    // installs actually use: ~/.lmstudio/models/<publisher>/<model>/*.gguf).
    if let Some(home) = dirs::home_dir() {
        let lm_studio_new = home.join(".lmstudio").join("models");
        all.extend(scan_folder(&lm_studio_new, "lm-studio"));
    }

    // LM Studio cache (Windows %LOCALAPPDATA% variant).
    if let Some(local_data) = dirs::data_local_dir() {
        let lm_studio_win = local_data.join("lm-studio").join("models");
        all.extend(scan_folder(&lm_studio_win, "lm-studio"));
    }

    // Downloads folder.
    if let Some(dl) = dirs::download_dir() {
        all.extend(scan_folder(&dl, "downloads"));
    }

    // Ollama blobs: walk ~/.ollama/models/blobs/ for sha256-* files which are
    // raw GGUF. We skip manifest parsing (the JSON indirection) and just treat
    // any file in blobs/ as a candidate — the GGUF magic check will reject
    // non-GGUF files quickly.
    if let Some(home) = dirs::home_dir() {
        let ollama_blobs = home.join(".ollama").join("models").join("blobs");
        all.extend(scan_folder(&ollama_blobs, "ollama"));
    }

    all
}

// ---- Sidecar registry ----

/// What a sidecar is for. Chat and embedding sidecars coexist (the corpus
/// embedder runs alongside the chat model); starting one kind never stops
/// the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarKind {
    Chat,
    Embedding,
}

/// Registry key for the embedding sidecar (it's a singleton by policy, like
/// the chat sidecar, but keyed apart so the two never evict each other).
pub const EMBEDDING_MODEL_KEY: &str = "__embedding__";

pub struct SidecarHandle {
    pub child: tokio::process::Child,
    pub port: u16,
    pub model_id: String,
    pub kind: SidecarKind,
    /// The effective context window (`-c`) the sidecar was launched with. The
    /// compaction framework reads this (via `status()`) so its threshold is
    /// always relative to the window the model actually has, not a hardcoded
    /// constant.
    pub n_ctx: u32,
    /// The effective `--n-gpu-layers` value that succeeded. Exposed to the UI
    /// so users can see partial offload (e.g., 32 layers on GPU, rest on CPU).
    pub n_gpu_layers: i32,
}

pub struct LocalModelRegistry {
    pub handles: Mutex<HashMap<String, SidecarHandle>>,
}

impl LocalModelRegistry {
    pub fn new() -> Self {
        Self {
            handles: Mutex::new(HashMap::new()),
        }
    }
}

// ---- LM Studio-style runtime overrides (persisted per model) ----

/// App-settings key holding the JSON `Record<modelId, LlamaOverrides>`
/// blob. Written by the frontend (settings panel + composer Apply), read
/// by every spawn path; `last_good_ngl` inside each entry is written by
/// the backend after a successful start.
pub const OVERRIDES_KEY: &str = "localModels.overrides";

/// Per-model llama-server runtime overrides — the LM Studio "runtime
/// settings" analog. `None` everywhere means "auto". `last_good_ngl` is
/// never user-set: the backend records the GPU-layer count of the last
/// successful start so respawns skip the probe ladder.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlamaOverrides {
    /// GPU layers (`--n-gpu-layers`). None = auto (last-good, else probe).
    pub ngl: Option<i32>,
    /// Context size (`-c`). None = auto-tiered by GGUF size.
    pub ctx: Option<u32>,
    /// Opt-in `--flash-attn` — unsupported builds fail the health-check
    /// at runtime, so it stays off by default.
    pub flash_attn: Option<bool>,
    /// KV-cache quant for the K cache: "f16" | "q8_0" | "q4_0" (V cache
    /// follows when flash-attn is on; llama.cpp requires FA for V quant).
    pub kv_cache: Option<String>,
    pub threads: Option<i32>,
    pub batch: Option<u32>,
    pub ubatch: Option<u32>,
    pub parallel: Option<u32>,
    pub no_mmap: Option<bool>,
    pub seed: Option<i64>,
    // Sampler defaults applied server-side (per-request values still win).
    pub temp: Option<f32>,
    pub top_p: Option<f32>,
    pub top_k: Option<i32>,
    pub min_p: Option<f32>,
    pub repeat_penalty: Option<f32>,
    /// Free-form extra args, whitespace-split and appended verbatim —
    /// the power-user escape hatch for flags we don't surface.
    pub extra_args: Option<String>,
    /// Auto-recorded ngl of the last successful start (backend-written).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_good_ngl: Option<i32>,
}

/// Append the override flags to a llama-server arg list. Order-stable and
/// idempotent per flag (retains removes any stale copy first, mirroring
/// how `--n-gpu-layers` is handled by the ladder). Unknown kv-cache
/// values are skipped rather than risking a bad flag.
pub fn apply_overrides_args(args: &mut Vec<String>, o: &LlamaOverrides) {
    let mut push = |flag: &str, val: String, args: &mut Vec<String>| {
        args.retain(|a| a != flag);
        args.push(flag.to_string());
        args.push(val);
    };
    if o.flash_attn == Some(true) {
        args.retain(|a| a != "--flash-attn");
        args.push("--flash-attn".to_string());
    }
    if let Some(kv) = o.kv_cache.as_deref() {
        if matches!(kv, "f16" | "q8_0" | "q4_0") {
            push("--cache-type-k", kv.to_string(), args);
            // V-cache quant requires flash attention; only mirror it when
            // FA is on so CPU/unpadded builds never get a rejected flag.
            if o.flash_attn == Some(true) {
                push("--cache-type-v", kv.to_string(), args);
            }
        }
    }
    if let Some(v) = o.threads {
        push("--threads", v.to_string(), args);
    }
    if let Some(v) = o.batch {
        push("--batch", v.to_string(), args);
    }
    if let Some(v) = o.ubatch {
        push("--ubatch", v.to_string(), args);
    }
    if let Some(v) = o.parallel {
        push("--parallel", v.to_string(), args);
    }
    if o.no_mmap == Some(true) {
        args.retain(|a| a != "--no-mmap");
        args.push("--no-mmap".to_string());
    }
    if let Some(v) = o.seed {
        push("--seed", v.to_string(), args);
    }
    if let Some(v) = o.temp {
        push("--temp", format!("{v}"), args);
    }
    if let Some(v) = o.top_p {
        push("--top-p", format!("{v}"), args);
    }
    if let Some(v) = o.top_k {
        push("--top-k", v.to_string(), args);
    }
    if let Some(v) = o.min_p {
        push("--min-p", format!("{v}"), args);
    }
    if let Some(v) = o.repeat_penalty {
        push("--repeat-penalty", format!("{v}"), args);
    }
    if let Some(extra) = o.extra_args.as_deref() {
        for tok in extra.split_whitespace() {
            args.push(tok.to_string());
        }
    }
}

/// The GPU-layer attempt ladder: the preferred rung (user override →
/// last-good → auto probe) followed by the fixed 64→32→16→8→4→0
/// fallback, deduped (e.g. user ngl=32 mustn't try 32 twice).
pub fn build_ngl_ladder(preferred: i32) -> Vec<i32> {
    let mut seen = std::collections::HashSet::new();
    [preferred, 64, 32, 16, 8, 4, 0]
        .into_iter()
        .filter(|x| seen.insert(*x))
        .collect()
}

/// Read the whole persisted overrides map. Corrupt/missing JSON settles
/// to an empty map — overrides are ergonomics, never a hard failure.
pub fn load_overrides_map(conn: &rusqlite::Connection) -> HashMap<String, LlamaOverrides> {
    crate::db::get_setting(conn, OVERRIDES_KEY)
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// The persisted overrides for one model (default when absent).
pub fn load_overrides(conn: &rusqlite::Connection, model_id: &str) -> LlamaOverrides {
    load_overrides_map(conn)
        .get(model_id)
        .cloned()
        .unwrap_or_default()
}

/// Record the ngl of a successful start into the persisted blob so the
/// next spawn starts there instead of re-probing. Best-effort: failures
/// only log.
pub fn save_last_good_ngl(conn: &rusqlite::Connection, model_id: &str, ngl: i32) {
    let mut map = load_overrides_map(conn);
    let entry = map.entry(model_id.to_string()).or_default();
    entry.last_good_ngl = Some(ngl);
    if let Ok(json) = serde_json::to_string(&map) {
        if let Err(e) = crate::db::set_setting(conn, OVERRIDES_KEY, &json) {
            eprintln!("[local-models] failed to persist last-good ngl: {e:?}");
        }
    }
}

impl LocalModelRegistry {
    /// Start a llama-server sidecar for the given model. Stops any existing
    /// CHAT sidecar first (v1: one chat model at a time; the embedding
    /// sidecar is independent and keeps running). `overrides` carries the
    /// user's persisted per-model runtime tweaks; None = defaults.
    pub async fn start(
        &self,
        model_id: String,
        gguf_path: &str,
        mmproj_path: Option<&str>,
        overrides: Option<&LlamaOverrides>,
    ) -> Result<StartedModel, String> {
        // Stop any running chat sidecar.
        self.stop_kind(SidecarKind::Chat).await;

        // Resolve llama-server binary (and its directory — on Windows the
        // process must run with the binary's dir as CWD so it can load sibling
        // DLLs like llama-server-impl.dll; otherwise spawn fails with
        // 0xC0000135 STATUS_DLL_NOT_FOUND).
        let resolved = resolve_llama_server_binary()?;
        let bin = &resolved.path;

        // Pick a free port.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("failed to bind port: {e}"))?;
        let port = listener.local_addr().map_err(|e| format!("local addr: {e}"))?.port();
        drop(listener);

        // GPU layers: user override → last successful count → auto probe.
        // The last-good rung is the "cached ngl" — a restart that previously
        // settled at, say, 40 layers starts there (one spawn+health-check)
        // instead of re-running the full probe ladder.
        let ovr = overrides.cloned().unwrap_or_default();
        let ngl = ovr
            .ngl
            .or(ovr.last_good_ngl)
            .unwrap_or_else(|| auto_ngl(gguf_path));

        // Auto-pick context size.
        let ctx = ovr.ctx.unwrap_or_else(|| auto_ctx_size(gguf_path));

        // Spawn llama-server. We deliberately do NOT pass `--flash-attn`: it is
        // a perf optimization, not required for correctness, and support varies
        // by build (CUDA-only on some, absent on older/CPU-only builds). An
        // unsupported flag fails at RUNTIME (the process spawns, then exits
        // with an "unrecognized argument" error) — NOT at `spawn()` time — so a
        // spawn-time retry can't catch it, and the failure would only surface
        // as a health-check timeout. Omitting it keeps the default path
        // universal and fast. (A future iteration can add it as an opt-in once
        // we detect a CUDA/Metal build.)
        let mut args_template: Vec<String> = {
            let mut v = vec![
                "--model".to_string(), gguf_path.to_string(),
                "--port".to_string(), port.to_string(),
                "--host".to_string(), "127.0.0.1".to_string(),
                "-c".to_string(), ctx.to_string(),
                // Required for the chat completions endpoint to accept a
                // `tools` array. Without it, llama-server returns HTTP 400
                // with "tools param requires --jinja flag" (pre-b4400 also
                // rejects `tools` + `stream` outright). Bundled builds stage
                // a recent llama.cpp; legacy user binaries (e.g. an old
                // llama-cuda drop) may not recognize the flag — the spawn
                // ladder below surfaces that as a start failure with the
                // real reason in stderr.
                "--jinja".to_string(),
            ];
            if let Some(mp) = mmproj_path {
                if !mp.is_empty() {
                    v.push("--mmproj".to_string());
                    v.push(mp.to_string());
                }
            }
            v
        };
        // Fold in the user's runtime tweaks (FA, KV quant, threads, batch,
        // sampler defaults, extra args…). Runs on the template so every
        // ladder attempt inherits them.
        apply_overrides_args(&mut args_template, &ovr);

        // Stepwise GPU-fallback ladder. We start with the smart-picked (or
        // user-override / last-good) ngl, then descend through 64 → 32 → 16
        // → 8 → 4 → 0 on OOM. Each step is a full spawn+health-check cycle.
        // This handles the case where the smart pick overshot (e.g., the
        // VRAM probe underestimated system VRAM usage at load time, or
        // llama.cpp's allocator rejected the requested count for
        // fragmentation reasons).
        //
        // Why linear and not binary search? llama.cpp's allocation behavior
        // isn't strictly monotonic with --n-gpu-layers: a model may fail at
        // ngl=32 but succeed at ngl=64 (or vice versa) due to how KV-cache
        // blocks are placed. Linear descent from high to low is safer, and
        // the health-check timeout (30–180s) dominates per-iteration cost.
        let oom_markers = [
            "ErrorOutOfDeviceMemory",
            "failed to allocate",
            "vk::Device::allocateMemory",
            "ggml_gallocr_reserve_n_impl",
            "CUDA_ERROR_OUT_OF_MEMORY",
            "out of memory",
        ];

        // Build the attempt ladder (deduped: a user/last-good ngl that is
        // already a fallback rung mustn't be tried twice).
        let attempt_ngls: Vec<i32> = build_ngl_ladder(ngl);

        for (attempt_idx, try_ngl) in attempt_ngls.iter().enumerate() {
            let try_ngl = *try_ngl;
            eprintln!(
                "[local-models] Attempt {}/{}: --n-gpu-layers={} (gguf={})",
                attempt_idx + 1,
                attempt_ngls.len(),
                try_ngl,
                gguf_path
            );

            let mut cmd = tokio::process::Command::new(&bin);
            let mut args = args_template.clone();
            // Insert/overwrite --n-gpu-layers at its original position. The
            // template omits it so we control placement; pop and push keeps
            // arg order stable for llama-server.
            args.retain(|a| a != "--n-gpu-layers");
            args.push("--n-gpu-layers".to_string());
            args.push(try_ngl.to_string());
            cmd.args(&args)
                .current_dir(&resolved.dir)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            #[cfg(windows)]
            {
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            if let Some(cuda_bin) = cuda_toolkit_bin() {
                let existing_path = std::env::var("PATH").unwrap_or_default();
                let new_path = if existing_path.is_empty() {
                    cuda_bin.to_string_lossy().to_string()
                } else {
                    format!("{};{}", cuda_bin.to_string_lossy(), existing_path)
                };
                cmd.env("PATH", new_path);
            }

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    if attempt_idx + 1 < attempt_ngls.len() {
                        // Try the next ngl value in the ladder.
                        eprintln!(
                            "[local-models] spawn failed with n-gpu-layers={}: {}; trying next step.",
                            try_ngl, e
                        );
                        continue;
                    }
                    return Err(format!(
                        "failed to spawn llama-server at {bin}: {e}. \
                         Install llama.cpp and ensure llama-server is on PATH, or set LLAMA_SERVER_PATH."
                    ));
                }
            };

            // Health-check loop. Bail early if the child died; capture its
            // output to decide whether the failure was an OOM (retry on CPU)
            // or a real error (return to caller).
            let timeout_secs: u64 = {
                let gb = fs::metadata(gguf_path)
                    .map(|m| m.len())
                    .unwrap_or(0) as f64
                    / (1024.0 * 1024.0 * 1024.0);
                (30.0 + gb * 15.0).clamp(30.0, 180.0) as u64
            };
            let health_url = format!("http://127.0.0.1:{port}/health");
            // Loopback-only client: never route local GGUF server checks
            // through a system proxy.
            let client = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap_or_default();
            let mut ready = false;
            let mut early_exit_output: Option<String> = None;
            for _ in 0..timeout_secs * 2 {
                match child.try_wait() {
                    Ok(Some(_status)) => {
                        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                        early_exit_output = Some(take_streams(&mut child).await);
                        break;
                    }
                    Ok(None) => {}
                    Err(_) => {}
                }
                match client.get(&health_url).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        ready = true;
                        break;
                    }
                    _ => {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    }
                }
            }

            if ready {
                let handle = SidecarHandle {
                    child,
                    port,
                    model_id: model_id.clone(),
                    kind: SidecarKind::Chat,
                    n_ctx: ctx,
                    n_gpu_layers: try_ngl,
                };
                self.handles.lock().insert(model_id.clone(), handle);
                if try_ngl == 0 {
                    eprintln!("[local-models] Model loaded on CPU only (--n-gpu-layers=0).");
                } else {
                    eprintln!(
                        "[local-models] Model loaded successfully with --n-gpu-layers={}.",
                        try_ngl
                    );
                }
                return Ok(StartedModel {
                    model_id,
                    port,
                    n_ctx: ctx,
                    n_gpu_layers: try_ngl,
                    base_url: format!("http://127.0.0.1:{port}"),
                });
            }

            // Not ready — either timed out, or the process exited early.
            // Drain streams and decide whether to retry.
            let (output, had_early_exit) = if let Some(ref o) = early_exit_output {
                (o.clone(), true)
            } else {
                let _ = child.kill().await;
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                let o = take_streams(&mut child).await;
                let _ = child.wait().await;
                (o, false)
            };

            let is_oom = oom_markers.iter().any(|m| output.contains(m));
            let is_last_attempt = attempt_idx + 1 == attempt_ngls.len();

            if is_oom && !is_last_attempt {
                let snippet: String = output
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .take(3)
                    .collect::<Vec<_>>()
                    .join(" | ");
                eprintln!(
                    "[local-models] n-gpu-layers={} hit OOM; stepping down. Snippet: {}",
                    try_ngl, snippet
                );
                continue;
            }

            // Non-OOM early exit: real error (bad model, wrong mmproj, etc.)
            if !is_oom && had_early_exit {
                // Special-case the --jinja flag: Clang 20.1.8 builds reject it
                // with "unrecognized argument" — try once more without it.
                let stderr = output.trim();
                let no_jinja =
                    stderr.contains("unrecognized argument")
                    || stderr.contains("invalid option flag");
                if no_jinja && args_template.contains(&"--jinja".to_string()) {
                    eprintln!(
                        "[local-models] --jinja rejected; retrying without it. Snippet: {}",
                        stderr.lines().take(1).collect::<String>()
                    );
                    args_template = args_template
                        .iter()
                        .filter(|arg| arg.as_str() != "--jinja")
                        .cloned()
                        .collect();
                    continue;
                }
                return Err(format!(
                    "llama-server exited during startup with --n-gpu-layers={}.\n{}",
                    try_ngl, output
                ));
            }
            // Timeout without early exit: model never became healthy.
            return Err(format!(
                "llama-server did not become healthy within {timeout_secs}s with --n-gpu-layers={}.\n{}",
                try_ngl, output
            ));
        }

        Err("llama-server: all startup attempts failed (all n-gpu-layers in the fallback ladder exhausted)".to_string())
    }

    /// Stop a specific sidecar by model_id.
    pub async fn stop(&self, model_id: &str) {
        let handle = self.handles.lock().remove(model_id);
        if let Some(mut h) = handle {
            let _ = h.child.kill().await;
            let _ = h.child.wait().await;
            eprintln!(
                "[local-models] ejected model_id={} port={}; VRAM released",
                model_id, h.port
            );
        }
    }

    /// Stop every sidecar of one kind. Chat starts stop chat sidecars only —
    /// the corpus embedder keeps running (and vice versa).
    pub async fn stop_kind(&self, kind: SidecarKind) {
        let keys: Vec<String> = self
            .handles
            .lock()
            .iter()
            .filter(|(_, h)| h.kind == kind)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            self.stop(&key).await;
        }
    }

    /// Stop all running sidecars. Called on app exit.
    pub async fn stop_all(&self) {
        let handles: Vec<SidecarHandle> = self.handles.lock().drain().map(|(_, h)| h).collect();
        for mut handle in handles {
            let _ = handle.child.kill().await;
            let _ = handle.child.wait().await;
        }
    }

    /// Return status of the running CHAT sidecar (v1: at most one). Embedding
    /// sidecars are deliberately invisible here — the warmup path keys on
    /// this, and an embedding-only registry must not look like "a chat model
    /// is running".
    pub fn status(&self) -> Option<ActiveLocalModel> {
        self.handles
            .lock()
            .values()
            .find(|h| h.kind == SidecarKind::Chat)
            .map(|h| ActiveLocalModel {
                model_id: h.model_id.clone(),
                port: h.port,
                n_ctx: h.n_ctx,
                n_gpu_layers: h.n_gpu_layers,
                base_url: format!("http://127.0.0.1:{}", h.port),
            })
    }

    /// Status of the embedding sidecar, if running.
    pub fn embedding_status(&self) -> Option<ActiveLocalModel> {
        self.handles
            .lock()
            .get(EMBEDDING_MODEL_KEY)
            .map(|h| ActiveLocalModel {
                model_id: h.model_id.clone(),
                port: h.port,
                n_ctx: h.n_ctx,
                n_gpu_layers: h.n_gpu_layers,
                base_url: format!("http://127.0.0.1:{}", h.port),
            })
    }

    /// Start the embedding sidecar (llama-server --embedding) for a corpus
    /// embedder GGUF. Small fixed context — nomic-embed-text is a 2k-ctx
    /// model and chunks are ~450 tokens. Stops any previous embedding
    /// sidecar; chat sidecars are untouched.
    pub async fn start_embedding(&self, gguf_path: &str) -> Result<StartedModel, String> {
        self.stop_kind(SidecarKind::Embedding).await;

        let resolved = resolve_llama_server_binary()?;
        let bin = &resolved.path;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("failed to bind port: {e}"))?;
        let port = listener.local_addr().map_err(|e| format!("local addr: {e}"))?.port();
        drop(listener);

        // Full GPU offload first, CPU fallback. The embedder is ~140 MB — OOM
        // is unlikely, but a crowded GPU can still reject the allocation.
        for try_ngl in [auto_ngl(gguf_path), 0] {
            let args = vec![
                "--model".to_string(), gguf_path.to_string(),
                "--port".to_string(), port.to_string(),
                "--host".to_string(), "127.0.0.1".to_string(),
                "-c".to_string(), "2048".to_string(),
                "--embedding".to_string(),
                "--n-gpu-layers".to_string(), try_ngl.to_string(),
            ];
            let mut cmd = tokio::process::Command::new(bin);
            cmd.args(&args)
                .current_dir(&resolved.dir)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(windows)]
            {
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    if try_ngl != 0 {
                        eprintln!("[local-models] embedding sidecar spawn failed (ngl={try_ngl}): {e}; retrying on CPU");
                        continue;
                    }
                    return Err(format!("failed to spawn llama-server for embeddings: {e}"));
                }
            };

            // Health poll: embedding models load in a few seconds.
            let health_url = format!("http://127.0.0.1:{port}/health");
            let client = reqwest::Client::builder().no_proxy().build().unwrap_or_default();
            let mut ready = false;
            for _ in 0..60 {
                match child.try_wait() {
                    Ok(Some(_)) => break, // died — next ladder step
                    _ => {}
                }
                match client.get(&health_url).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        ready = true;
                        break;
                    }
                    _ => tokio::time::sleep(std::time::Duration::from_millis(500)).await,
                }
            }
            if ready {
                self.handles.lock().insert(
                    EMBEDDING_MODEL_KEY.to_string(),
                    SidecarHandle {
                        child,
                        port,
                        model_id: EMBEDDING_MODEL_KEY.to_string(),
                        kind: SidecarKind::Embedding,
                        n_ctx: 2048,
                        n_gpu_layers: try_ngl,
                    },
                );
                eprintln!("[local-models] embedding sidecar up on port {port} (ngl={try_ngl})");
                return Ok(StartedModel {
                    model_id: EMBEDDING_MODEL_KEY.to_string(),
                    port,
                    n_ctx: 2048,
                    n_gpu_layers: try_ngl,
                    base_url: format!("http://127.0.0.1:{port}"),
                });
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        Err("llama-server embedding sidecar failed to start (GPU and CPU)".to_string())
    }
}

/// Embed a batch of texts against a running embedding sidecar
/// (`POST /embedding`). Returns one vector per input, in order. Tolerant of
/// both llama-server response shapes: flat `[{embedding: [..]}]` and pooled
/// `[{embedding: [[..]]}]` (pooling wraps the vector one level deeper).
pub async fn embed_texts(base_url: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let body = if texts.len() == 1 {
        serde_json::json!({ "content": texts[0] })
    } else {
        serde_json::json!({ "content": texts })
    };
    let resp = client
        .post(format!("{base_url}/embedding"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("embedding request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("embedding HTTP {status}: {}", text.chars().take(200).collect::<String>()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    parse_embedding_response(&json, texts.len())
}

/// Extract `expected` vectors from a llama-server /embedding response.
fn parse_embedding_response(json: &serde_json::Value, expected: usize) -> Result<Vec<Vec<f32>>, String> {
    let arr = json.as_array().ok_or_else(|| "embedding response is not an array".to_string())?;
    let mut out = Vec::with_capacity(expected);
    for item in arr.iter().take(expected) {
        let emb = item
            .get("embedding")
            .ok_or_else(|| "embedding item missing `embedding`".to_string())?;
        // Flat: [f32, …]. Pooled: [[f32, …]] — take the first row.
        let row = if emb.as_array().and_then(|a| a.first()).is_some_and(|v| v.is_array()) {
            emb.get(0).cloned().unwrap_or(emb.clone())
        } else {
            emb.clone()
        };
        let vec: Vec<f32> = row
            .as_array()
            .ok_or_else(|| "embedding row is not an array".to_string())?
            .iter()
            .filter_map(|v| v.as_f64().map(|f| f as f32))
            .collect();
        if vec.is_empty() {
            return Err("embedding vector is empty".to_string());
        }
        out.push(vec);
    }
    if out.len() != expected {
        return Err(format!("embedding response had {} vectors, expected {expected}", out.len()));
    }
    Ok(out)
}

// ---- Sidecar response types ----

/// Drain the child's captured stdout AND stderr into a single string.
/// llama-server writes most of its output (including load errors like
/// "unsupported model architecture: 'clip'") to stdout, with some to stderr —
/// capturing both ensures the user always sees the real failure reason instead
/// of an empty "stderr:" line. Best-effort: pipes already taken / closed yield
/// empty strings rather than panicking.
async fn take_streams(child: &mut tokio::process::Child) -> String {
    async fn drain(opt: Option<tokio::process::ChildStdout>) -> String {
        match opt {
            Some(mut r) => {
                use tokio::io::AsyncReadExt;
                let mut buf = Vec::new();
                let _ = r.read_to_end(&mut buf).await;
                String::from_utf8_lossy(&buf).to_string()
            }
            None => String::new(),
        }
    }
    // stderr is a different type (ChildStderr) but reads identically.
    let stdout = drain(child.stdout.take()).await;
    let stderr = match child.stderr.take() {
        Some(mut r) => {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).to_string()
        }
        None => String::new(),
    };
    // Prefer the combined output; stdout carries the load-error lines.
    let mut out = stdout;
    if !stderr.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&stderr);
    }
    out
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedModel {
    pub model_id: String,
    pub port: u16,
    pub n_ctx: u32,
    /// Effective `--n-gpu-layers` that succeeded. 0 = CPU-only, >0 = partial
    /// or full GPU offload. The UI uses this to show "X layers on GPU" so the
    /// user understands why a model that was too big is now working.
    pub n_gpu_layers: i32,
    pub base_url: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveLocalModel {
    pub model_id: String,
    pub port: u16,
    pub n_ctx: u32,
    /// Effective `--n-gpu-layers` of the running sidecar.
    pub n_gpu_layers: i32,
    pub base_url: String,
}

// ---- Port / binary helpers ----

/// Resolved llama-server binary plus the directory it lives in. The directory
/// is returned separately because on Windows a source-built `llama-server.exe`
/// links sibling DLLs (`llama-server-impl.dll`) that Windows only finds if the
/// process's working directory (or default DLL search path) is the binary's
/// folder — spawning it from the app's CWD fails with `0xC0000135`
/// (STATUS_DLL_NOT_FOUND). The spawn site sets `current_dir` to this.
struct ResolvedBinary {
    path: String,
    dir: PathBuf,
}

fn resolve_llama_server_binary() -> Result<ResolvedBinary, String> {
    let to_resolved = |p: PathBuf| -> ResolvedBinary {
        let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
        ResolvedBinary { path: p.to_string_lossy().to_string(), dir }
    };

    // 0. Bundled sidecar (highest priority). The `llama-server-<triple>`
    //    launcher Tauri stages as an externalBin, with the sibling .so /
    //    .dll / .dylib files in the same dir (from bundle.resources). The
    //    launcher uses RUNPATH $ORIGIN to find them, so the dir returned
    //    here MUST be used as current_dir at spawn time.
    if let Some(dir) = bundled_llama_server_dir() {
        let bin_name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
        let launcher = dir.join(bin_name);
        if launcher.is_file() {
            return Ok(ResolvedBinary {
                path: launcher.to_string_lossy().to_string(),
                dir,
            });
        }
    }

    // 1. LLAMA_SERVER_PATH env var: a file, or a directory containing the binary.
    if let Ok(path) = std::env::var("LLAMA_SERVER_PATH") {
        let p = Path::new(&path);
        let bin_name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
        let resolved_file = if p.is_file() {
            Some(p.to_path_buf())
        } else if cfg!(windows) && p.with_extension("exe").is_file() {
            Some(p.with_extension("exe"))
        } else if p.is_dir() && p.join(bin_name).is_file() {
            Some(p.join(bin_name))
        } else {
            None
        };
        if let Some(file) = resolved_file {
            return Ok(to_resolved(file));
        }
    }

    // 2. Look for the binary on PATH by running `--version`. NOTE: on Windows
    // the version probe must run with the binary's own dir as CWD, otherwise a
    // source build fails to load its sibling DLLs and the probe falsely reports
    // "not found" even when llama-server IS on PATH. We can't know the dir from
    // a bare PATH lookup until we resolve it, so on Windows we instead rely on
    // the explicit candidate scan below (step 3) which sets the dir correctly.
    // On non-Windows a bare PATH invocation is safe (no sibling-DLL issue).
    let bin_name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    if !cfg!(windows) {
        let output = std::process::Command::new(bin_name)
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output();
        if let Ok(out) = output {
            if out.status.success() {
                return Ok(ResolvedBinary {
                    path: bin_name.to_string(),
                    dir: PathBuf::from("."),
                });
            }
        }
    }

    // 3. Common install locations. On Windows this covers the conventional
    // source-build tree under C:\llama.cpp; anything else (custom drives,
    // CUDA builds, release-zip layouts) should be pointed at explicitly via
    // LLAMA_SERVER_PATH rather than guessed by scanning drives.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        candidates.push(PathBuf::from(r"C:\llama.cpp\build\bin\Release\llama-server.exe"));
        candidates.push(PathBuf::from(r"C:\llama.cpp\build\bin\llama-server.exe"));
    } else {
        candidates.push(PathBuf::from("/usr/local/bin/llama-server"));
        candidates.push(PathBuf::from("/opt/llama.cpp/build/bin/llama-server"));
        candidates.push(PathBuf::from("/usr/bin/llama-server"));
        // macOS Homebrew (Apple Silicon default prefix).
        candidates.push(PathBuf::from("/opt/homebrew/bin/llama-server"));
        // macOS Homebrew (Intel prefix).
        candidates.push(PathBuf::from("/usr/local/opt/llama.cpp/bin/llama-server"));
    }
    for p in candidates {
        if p.is_file() {
            return Ok(to_resolved(p));
        }
    }

    Err(
        "llama-server not found. Install llama.cpp and ensure llama-server is \
        on your PATH, or set the LLAMA_SERVER_PATH environment variable to the \
        binary (or its folder). On Windows, a source build lives at \
        <drive>:\\llama.cpp\\build\\bin\\llama-server.exe."
            .to_string(),
    )
}

/// Resolve the NVIDIA CUDA Toolkit `bin` directory, if installed, so its
/// runtime DLLs (cudart64_*, cublas64_*, cublasLt64_*, …) can be injected into
/// the llama-server child's PATH. Scans the standard Windows install root for
/// any version (`v12.8`, `v11.7`, …). Returns None on non-Windows or when no
/// CUDA Toolkit is installed — in which case a non-CUDA llama-server build
/// needs no injection, and a CUDA build will fail with a clear DLL error.
fn cuda_toolkit_bin() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let root = PathBuf::from(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA");
    let versions = fs::read_dir(&root).ok()?;
    // Pick the highest version present (lexicographic works for vNN.N names).
    let mut best: Option<String> = None;
    for entry in versions.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if name.starts_with('v') && entry.path().join("bin").is_dir() {
                if best.as_deref().map_or(true, |b| name > b) {
                    best = Some(name.to_string());
                }
            }
        }
    }
    best.map(|v| root.join(v).join("bin"))
}

/// Default: try full GPU offload first. We always start with 999 unless the user
/// explicitly set a lower override. The stepwise ladder in `start()` handles
/// the case where 999 OOMs — it will step down through 64/32/16/8/4/0.
/// The VRAM probe is only used for logging / heuristics; it no longer gates the
/// default behavior because the fallback ladder is fast enough.
fn auto_ngl(gguf_path: &str) -> i32 {
    // Read GGUF size for logging.
    let gguf_bytes = match fs::metadata(gguf_path).map(|m| m.len()) {
        Ok(b) if b > 0 => b,
        _ => {
            eprintln!("[local-models] auto_ngl: cannot stat {gguf_path}; using CPU-only.");
            return 0;
        }
    };

    // Query free VRAM for logging.
    let free_vram_bytes = query_free_vram_bytes().unwrap_or(0);

    if free_vram_bytes > 0 {
        eprintln!(
            "[local-models] auto_ngl: GGUF={} MiB, free VRAM={} MiB, trying full offload (999).",
            gguf_bytes / (1024 * 1024),
            free_vram_bytes / (1024 * 1024)
        );
    } else {
        eprintln!(
            "[local-models] auto_ngl: GGUF={} MiB, no VRAM probe, trying full offload (999).",
            gguf_bytes / (1024 * 1024)
        );
    }

    999
}

/// Query free GPU VRAM via NVML (Windows). NVML ships with every NVIDIA driver
/// and is at C:\Windows\System32\nvml.dll. We don't link the official
/// nvml-wrapper crate (it drags in CUDA toolkit build deps). Instead we
/// dynamically load the DLL, resolve four function pointers, and call them.
///
/// Returns the largest free VRAM across all NVIDIA GPUs in bytes, or None if
/// NVML is unavailable (no NVIDIA GPU, no driver, or function resolution
/// failed). On non-Windows, returns None; on Windows the call is wrapped in
/// `OnceLock` so we don't repeatedly LoadLibraryA on every model load.
#[cfg(windows)]
fn query_free_vram_bytes() -> Option<u64> {
    use std::os::raw::{c_int, c_uint};
    use std::ptr;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{FARPROC, HMODULE};
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};

    // Opaque NVML device handle (we never dereference it; we just pass it back).
    #[repr(C)]
    #[allow(non_snake_case)]
    struct nvmlDevice_t {
        _private: [u8; 0],
    }
    #[repr(C)]
    #[allow(non_snake_case)]
    struct nvmlMemory_t {
        total: u64,
        free: u64,
        used: u64,
    }

    type NvmlInit = unsafe extern "system" fn() -> c_int;
    type NvmlDeviceGetHandleByIndex =
        unsafe extern "system" fn(c_uint, *mut *mut nvmlDevice_t) -> c_int;
    type NvmlDeviceGetMemoryInfo =
        unsafe extern "system" fn(*mut nvmlDevice_t, *mut nvmlMemory_t) -> c_int;
    type NvmlShutdown = unsafe extern "system" fn() -> c_int;

    struct NvmlFns {
        init: NvmlInit,
        device_get_handle_by_index: NvmlDeviceGetHandleByIndex,
        device_get_memory_info: NvmlDeviceGetMemoryInfo,
        shutdown: NvmlShutdown,
    }

    static NVML: OnceLock<Option<NvmlFns>> = OnceLock::new();

    let fns = NVML.get_or_init(|| unsafe {
        // "nvml.dll\0" — LoadLibraryA takes PCSTR (a *const u8 in windows-sys 0.61).
        let lib_name: [u8; 9] = *b"nvml.dll\0";
        let lib: HMODULE = LoadLibraryA(lib_name.as_ptr());
        if lib.is_null() {
            eprintln!("[local-models] nvml.dll not found (no NVIDIA driver?).");
            return None;
        }

        // GetProcAddress takes PCSTR (function name). NVML exports unversioned
        // names like nvmlInit, nvmlDeviceGetHandleByIndex — every consumer
        // (nvidia-smi, etc.) uses these. We append \0 inline.
        let resolve = |name: &[u8]| -> Option<FARPROC> {
            if name.len() + 1 > 64 {
                return None;
            }
            let mut cstr = [0u8; 64];
            cstr[..name.len()].copy_from_slice(name);
            let p = GetProcAddress(lib, cstr.as_ptr());
            if p.is_none() {
                eprintln!(
                    "[local-models] nvml: GetProcAddress failed for {}",
                    std::str::from_utf8(name).unwrap_or("?")
                );
                None
            } else {
                Some(p)
            }
        };

        // Transmute FARPROC → the typed function pointer. FARPROC is *mut c_void
        // in windows-sys 0.61. The transmute is sound because the resolved
        // address points at a real function with the signature we declare.
        let init_addr = resolve(b"nvmlInit\0")?;
        let dhbi_addr = resolve(b"nvmlDeviceGetHandleByIndex\0")?;
        let dgmi_addr = resolve(b"nvmlDeviceGetMemoryInfo\0")?;
        let shutdown_addr = resolve(b"nvmlShutdown\0")?;

        Some(NvmlFns {
            init: std::mem::transmute::<FARPROC, NvmlInit>(init_addr),
            device_get_handle_by_index: std::mem::transmute::<FARPROC, NvmlDeviceGetHandleByIndex>(dhbi_addr),
            device_get_memory_info: std::mem::transmute::<FARPROC, NvmlDeviceGetMemoryInfo>(dgmi_addr),
            shutdown: std::mem::transmute::<FARPROC, NvmlShutdown>(shutdown_addr),
        })
    });

    let fns = fns.as_ref()?;

    unsafe {
        if (fns.init)() != 0 {
            // NVML init failed (driver not loaded, no GPUs visible). Stay
            // silent here — the caller logs a fallback message.
            return None;
        }

        // Walk device indexes 0..8 and pick the largest free VRAM. NVML doesn't
        // expose a "device count" without nvmlDeviceGetCount, which would mean
        // resolving one more symbol. Probing by index is fine — invalid indexes
        // return NVML_ERROR_NOT_FOUND and we stop.
        let mut max_free: u64 = 0;
        let mut found_any = false;
        for idx in 0..8u32 {
            let mut dev: *mut nvmlDevice_t = ptr::null_mut();
            let rc = (fns.device_get_handle_by_index)(idx, &mut dev);
            if rc != 0 {
                break; // No more devices.
            }
            let mut mem = nvmlMemory_t {
                total: 0,
                free: 0,
                used: 0,
            };
            let rc = (fns.device_get_memory_info)(dev, &mut mem);
            if rc == 0 {
                if mem.free > max_free {
                    max_free = mem.free;
                }
                found_any = true;
            }
        }

        let _ = (fns.shutdown)();

        if !found_any {
            return None;
        }
        Some(max_free)
    }
}

/// Non-Windows stub: NVML probe is Windows-only in this build. The stepwise
/// fallback still works — the only loss is the smart first guess.
#[cfg(not(windows))]
fn query_free_vram_bytes() -> Option<u64> {
    None
}

/// Query the largest TOTAL dedicated VRAM across all discrete GPUs via DXGI.
/// Unlike `query_free_vram_bytes` (NVIDIA-only, free VRAM, used for logging),
/// this is vendor-agnostic (NVIDIA + AMD + Intel) and reads total capacity —
/// the stable "will the model fit resident" metric used by the model-market
/// size gate. Integrated GPUs (Intel UHD, AMD APUs) report 0 dedicated VRAM
/// and are skipped; callers fall back to system RAM for those.
///
/// Returns `Some((bytes, device_name))` for the adapter with the most dedicated
/// VRAM, or `None` when no discrete GPU is found / DXGI is unavailable.
#[cfg(windows)]
pub fn query_total_vram_bytes() -> Option<(u64, String)> {
    use std::sync::OnceLock;
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

    static DXGI: OnceLock<Option<(u64, String)>> = OnceLock::new();
    DXGI.get_or_init(|| unsafe {
        // CreateDXGIFactory1 fails if DirectX isn't available (headless / RDP
        // without GPU remoting). Treat as "no GPU" rather than crashing.
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let mut best_bytes: u64 = 0;
        let mut best_name = String::new();
        // EnumAdapters1 returns Err at the first invalid index, so loop until err.
        for idx in 0..8u32 {
            let adapter = match factory.EnumAdapters1(idx) {
                Ok(a) => a,
                Err(_) => break,
            };
            let desc = match adapter.GetDesc1() {
                Ok(d) => d,
                Err(_) => continue,
            };
            // Skip the Microsoft Basic Render Driver and other software adapters.
            if desc.VendorId == 0x1414 {
                continue;
            }
            if (desc.DedicatedVideoMemory as u64) > best_bytes {
                best_bytes = desc.DedicatedVideoMemory as u64;
                // Description is a wide UTF-16 string; trim trailing NULs.
                let name = String::from_utf16_lossy(
                    &desc.Description
                        .iter()
                        .take_while(|c| **c != 0)
                        .copied()
                        .collect::<Vec<u16>>(),
                );
                best_name = name.trim().to_string();
            }
        }
        if best_bytes == 0 {
            None
        } else {
            Some((best_bytes, best_name))
        }
    })
    .clone()
}

/// Non-Windows stub: DXGI probe is Windows-only in this build. Callers fall
/// back to system-RAM-based sizing on other platforms.
#[cfg(not(windows))]
pub fn query_total_vram_bytes() -> Option<(u64, String)> {
    None
}

fn auto_ctx_size(gguf_path: &str) -> u32 {
    // The context must fit the app's OWN prompt overhead, not just the chat
    // history: tool-mode turns add the full tool schema (~5-6k tokens) plus
    // the system prompt on top of the conversation, and llama-server hard-
    // rejects any prompt that exceeds n_ctx with a 400
    // (exceed_context_size_error). The local-model system prompt is kept
    // compact (tool descriptions live in the tools array, not duplicated in
    // the prompt), so 32768 fits a real tool-enabled conversation. Tiering:
    // models <= 8GB get 32768, larger models 16384 / 8192. KV-cache memory
    // scales with ctx, but at these tiers it stays practical on CPU-only and
    // low-VRAM machines (excess KV spills to CPU; llama-server handles the
    // mixed placement). All locally-supported models carry n_ctx_train >=
    // 32768, so these sizes load cleanly.
    let size = match fs::metadata(gguf_path) {
        Ok(m) => m.len(),
        Err(_) => return 32768,
    };
    let gb = size as f64 / (1024.0 * 1024.0 * 1024.0);
    if gb < 8.0 {
        32768
    } else if gb < 16.0 {
        16384
    } else {
        8192
    }
}

// ---- Tauri state wrapper ----

/// Arc-wrapped registry managed by Tauri (injected via `app.manage()`).
pub struct LocalModelState(pub Arc<LocalModelRegistry>);

// ---- Bundled binary resolution (sidecar) ----

/// Host target triple, baked at compile time the same way
/// `browser_mcp_register.rs` does it. Used to find the bundled
/// `llama-server-<triple>` launcher that Tauri stages as an externalBin.
const HOST_TRIPLE: &str = if cfg!(target_os = "windows") {
    if cfg!(target_arch = "aarch64") {
        "aarch64-pc-windows-msvc"
    } else {
        "x86_64-pc-windows-msvc"
    }
} else if cfg!(target_os = "macos") {
    if cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else {
        "x86_64-apple-darwin"
    }
} else if cfg!(target_os = "linux") {
    if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    }
} else {
    "unknown-target"
};

/// `bin/` directory next to the running main exe where Tauri stages
/// externalBin sidecars in a packaged install. Same layout as
/// `browser_mcp_register.rs::mcp_binary_path()` — checked first because the
/// installer always drops sidecars there.
fn bundled_sidecar_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // Tauri 2 externalBin layout: <exe_dir>/<name>-<triple>[.exe].
    // browser_mcp_register looks under "binaries/" because that's how
    // the dev-source binary is laid out, but Tauri's actual sidecar
    // location is right next to the main exe.
    let sidecar_name = if cfg!(windows) {
        format!("llama-server-{}.exe", HOST_TRIPLE)
    } else {
        format!("llama-server-{}", HOST_TRIPLE)
    };
    let sidecar = dir.join(&sidecar_name);
    if sidecar.is_file() {
        Some(dir.to_path_buf())
    } else {
        // Fallback: dev layout / NSIS root where binaries/ holds the sidecars.
        let nested = dir.join("binaries").join(&sidecar_name);
        if nested.is_file() {
            return nested.parent().map(|p| p.to_path_buf());
        }
        if let Some(install_root) = dir.parent() {
            let nested_root = install_root.join("binaries").join(&sidecar_name);
            if nested_root.is_file() {
                return nested_root.parent().map(|p| p.to_path_buf());
            }
        }
        None
    }
}

/// Resolve the bundled `llama-server` sidecar shipped alongside the main
/// executable. The sidecar is just a small launcher that dlopens several
/// sibling .so / .dll / .dylib files via `RUNPATH: $ORIGIN`, so the caller
/// must spawn it with `current_dir` set to the directory returned here
/// (the directory containing the launcher AND the .so files).
///
/// Returns `None` if no bundled sidecar is found — in that case the caller
/// falls back to the env-var / PATH / hardcoded-location chain in
/// `resolve_llama_server_binary()`.
pub fn bundled_llama_server_dir() -> Option<std::path::PathBuf> {
    bundled_sidecar_dir()
}

#[cfg(test)]
mod bundled_tests {
    use super::*;

    #[test]
    fn host_triple_is_not_unknown() {
        // The const is set for the four supported triples (Windows,
        // macOS arm64/x64, Linux arm64/x64). A compile-time build of any
        // other target would still compile but should fail at runtime.
        assert_ne!(HOST_TRIPLE, "unknown-target", "host triple must be set");
    }

    #[test]
    fn bundled_dir_returns_none_or_existing() {
        // On dev machines (no bundle), returns None. On packaged installs,
        // returns the directory the sidecar lives in. Either is fine — this
        // test just makes sure the helper doesn't panic.
        if let Some(d) = bundled_llama_server_dir() {
            assert!(d.is_dir(), "bundled dir must be a real directory");
        }
    }
}

#[cfg(test)]
mod scanner_tests {
    use super::*;
    use std::io::Write;

    /// Minimal GGUF header: magic + version + tensor_count + kv_count(0).
    fn tiny_gguf_bytes() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"GGUF"); // magic
        v.extend_from_slice(&3u32.to_le_bytes()); // version
        v.extend_from_slice(&0u64.to_le_bytes()); // tensor count
        v.extend_from_slice(&0u64.to_le_bytes()); // metadata kv count
        v
    }

    fn push_gguf_string(v: &mut Vec<u8>, s: &str) {
        v.extend_from_slice(&(s.len() as u64).to_le_bytes());
        v.extend_from_slice(s.as_bytes());
    }

    /// GGUF carrying an array KV followed by scalar + string KVs — the
    /// desync scenario from the array-count fix. Per the GGUF spec an array
    /// value header is u32 element-type + u64 element-count; reading count
    /// as u32 left the high half in the stream, so the payload skip started
    /// 4 bytes early and EVERY KV after the first array parsed as garbage
    /// (tokenizer arrays are ubiquitous, so in practice all extracted
    /// metadata came back empty for real models).
    fn gguf_bytes_with_array_kv() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"GGUF"); // magic
        v.extend_from_slice(&3u32.to_le_bytes()); // version
        v.extend_from_slice(&0u64.to_le_bytes()); // tensor count
        v.extend_from_slice(&4u64.to_le_bytes()); // metadata kv count

        // KV 1: array of strings (tokenizer-style).
        push_gguf_string(&mut v, "tokenizer.ggml.tokens");
        v.extend_from_slice(&9u32.to_le_bytes()); // value type: array
        v.extend_from_slice(&8u32.to_le_bytes()); // element type: string
        v.extend_from_slice(&2u64.to_le_bytes()); // element count (u64 per spec)
        push_gguf_string(&mut v, "<bos>");
        push_gguf_string(&mut v, "<eos>");

        // KV 2: scalar (uint32) — exercises the scalar-skip arm after an array.
        push_gguf_string(&mut v, "general.context_length");
        v.extend_from_slice(&6u32.to_le_bytes()); // value type: uint32
        v.extend_from_slice(&4096u32.to_le_bytes());

        // KV 3: the metadata we actually extract.
        push_gguf_string(&mut v, "general.name");
        v.extend_from_slice(&8u32.to_le_bytes()); // value type: string
        push_gguf_string(&mut v, "desync-test-model");

        // KV 4: second string — alignment must hold past the first
        // post-array KV, not just into it.
        push_gguf_string(&mut v, "general.architecture");
        v.extend_from_slice(&8u32.to_le_bytes());
        push_gguf_string(&mut v, "llama");

        v
    }

    #[test]
    fn parse_gguf_array_kv_does_not_desync_following_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("model.gguf");
        fs::File::create(&p)
            .unwrap()
            .write_all(&gguf_bytes_with_array_kv())
            .unwrap();
        let meta = parse_gguf(&p);
        assert_eq!(meta.name.as_deref(), Some("desync-test-model"));
        assert_eq!(meta.architecture.as_deref(), Some("llama"));
    }

    #[test]
    fn scan_folder_finds_gguf_by_extension() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("model.Q4_K_M.gguf");
        fs::File::create(&p).unwrap().write_all(&tiny_gguf_bytes()).unwrap();
        let found = scan_folder(dir.path(), "user");
        assert_eq!(found.len(), 1, "should detect .gguf by extension");
        assert_eq!(found[0].filename, "model.Q4_K_M.gguf");
    }

    #[test]
    fn scan_folder_skips_extensionless_for_normal_sources() {
        // A GGUF-magic file WITHOUT the .gguf extension must NOT be picked
        // up for user/lm-studio/downloads scans — only Ollama's blob store
        // gets the magic-byte fallback.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sha256-abcd1234");
        fs::File::create(&p).unwrap().write_all(&tiny_gguf_bytes()).unwrap();
        assert!(scan_folder(dir.path(), "user").is_empty());
        assert!(scan_folder(dir.path(), "lm-studio").is_empty());
    }

    #[test]
    fn scan_folder_ollama_detects_extensionless_blob_via_magic() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sha256-abcd1234");
        fs::File::create(&p).unwrap().write_all(&tiny_gguf_bytes()).unwrap();
        let found = scan_folder(dir.path(), "ollama");
        assert_eq!(found.len(), 1, "ollama blobs must be detected via GGUF magic");
    }

    #[test]
    fn scan_folder_ollama_rejects_non_gguf_blob() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sha256-notreallyagguf");
        fs::File::create(&p).unwrap().write_all(b"{\"json\":\"manifest\"}").unwrap();
        assert!(scan_folder(dir.path(), "ollama").is_empty());
    }

    #[test]
    fn default_locations_includes_new_lmstudio_path() {
        // Regression: LM Studio ≥0.3 stores models in ~/.lmstudio/models —
        // the scanner must look there, not just the legacy .cache path.
        // We can't create dirs in the real home from a test, so assert on
        // the path-join logic indirectly: if the dir exists on this machine
        // the scan must find its .gguf files; if it doesn't exist the scan
        // must not error either way.
        let _ = scan_default_locations(); // must not panic
        if let Some(home) = dirs::home_dir() {
            let new_path = home.join(".lmstudio").join("models");
            if new_path.is_dir() {
                let found = scan_folder(&new_path, "lm-studio");
                let has_gguf = walkdir::WalkDir::new(&new_path)
                    .max_depth(6)
                    .into_iter()
                    .filter_map(|e| e.ok())
                    .any(|e| {
                        e.file_type().is_file()
                            && e.file_name().to_string_lossy().to_lowercase().ends_with(".gguf")
                    });
                if has_gguf {
                    assert!(
                        !found.is_empty(),
                        "~/.lmstudio/models contains .gguf files but scan found none"
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ngl_ladder_dedupes_and_orders() {
        // Auto probe (999) leads, full fallback follows.
        assert_eq!(build_ngl_ladder(999), vec![999, 64, 32, 16, 8, 4, 0]);
        // A user/last-good rung that is also a fallback rung mustn't repeat.
        assert_eq!(build_ngl_ladder(32), vec![32, 64, 16, 8, 4, 0]);
        assert_eq!(build_ngl_ladder(0), vec![0, 64, 32, 16, 8, 4]);
    }

    #[test]
    fn overrides_args_spell_each_flag_once() {
        let o = LlamaOverrides {
            flash_attn: Some(true),
            kv_cache: Some("q8_0".into()),
            threads: Some(8),
            batch: Some(512),
            ubatch: Some(128),
            parallel: Some(2),
            no_mmap: Some(true),
            seed: Some(42),
            temp: Some(0.7),
            top_p: Some(0.9),
            top_k: Some(40),
            min_p: Some(0.05),
            repeat_penalty: Some(1.1),
            extra_args: Some("--foo bar".into()),
            ..Default::default()
        };
        // Pre-existing stale flag values must be replaced, not duplicated.
        let mut args = vec!["--model".to_string(), "x.gguf".into(), "--threads".into(), "4".into()];
        apply_overrides_args(&mut args, &o);
        assert_eq!(args.iter().filter(|a| *a == "--threads").count(), 1);
        let idx = args.iter().position(|a| a == "--threads").unwrap();
        assert_eq!(args[idx + 1], "8");
        for flag in [
            "--flash-attn",
            "--cache-type-k",
            "--cache-type-v",
            "--batch",
            "--ubatch",
            "--parallel",
            "--no-mmap",
            "--seed",
            "--temp",
            "--top-p",
            "--top-k",
            "--min-p",
            "--repeat-penalty",
        ] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}");
        }
        assert!(args.windows(2).any(|w| w[0] == "--cache-type-k" && w[1] == "q8_0"));
        // Extra args are split on whitespace and appended verbatim.
        assert!(args.iter().any(|a| a == "--foo"));
        assert!(args.iter().any(|a| a == "bar"));
    }

    #[test]
    fn overrides_args_skip_unknown_kv_and_gate_v_on_fa() {
        let mut args = vec![];
        apply_overrides_args(&mut args, &LlamaOverrides { kv_cache: Some("bogus".into()), ..Default::default() });
        assert!(args.is_empty(), "unknown kv value skipped entirely");

        let mut args = vec![];
        apply_overrides_args(&mut args, &LlamaOverrides { kv_cache: Some("q4_0".into()), ..Default::default() });
        assert!(args.iter().any(|a| a == "--cache-type-k"));
        assert!(!args.iter().any(|a| a == "--cache-type-v"), "V quant requires FA");

        let mut args = vec![];
        apply_overrides_args(&mut args, &LlamaOverrides { flash_attn: Some(false), ..Default::default() });
        assert!(args.is_empty(), "explicit false stays off");
    }

    #[test]
    fn overrides_persist_round_trip_merge_and_lenient_parse() {
        let conn = crate::db::mem();
        assert!(load_overrides(&conn, "m1").ngl.is_none());
        save_last_good_ngl(&conn, "m1", 40);
        assert_eq!(load_overrides(&conn, "m1").last_good_ngl, Some(40));

        // Merge preserves sibling models and their fields.
        crate::db::set_setting(&conn, OVERRIDES_KEY, r#"{"m2":{"ngl":8}}"#).unwrap();
        save_last_good_ngl(&conn, "m1", 12);
        assert_eq!(load_overrides(&conn, "m2").ngl, Some(8));
        assert_eq!(load_overrides(&conn, "m1").last_good_ngl, Some(12));

        // Corrupt blob settles to an empty map, never panics.
        crate::db::set_setting(&conn, OVERRIDES_KEY, "not json").unwrap();
        assert!(load_overrides_map(&conn).is_empty());
    }

    #[test]
    fn embedding_arches_are_recognized() {
        for arch in ["bert", "nomic-bert", "jina-bert-v2", "jina-bert-v3"] {
            assert!(is_embedding_arch(arch), "{arch}");
        }
        for arch in ["llama", "qwen2", "gemma3", "clip", "mmproj"] {
            assert!(!is_embedding_arch(arch), "{arch}");
        }
    }

    #[test]
    fn parse_flat_embedding_response() {
        let json = serde_json::json!([
            {"index": 0, "embedding": [0.1, 0.2, 0.3]},
            {"index": 1, "embedding": [0.4, 0.5, 0.6]}
        ]);
        let out = parse_embedding_response(&json, 2).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], vec![0.1f32, 0.2, 0.3]);
    }

    #[test]
    fn parse_pooled_embedding_response() {
        // Pooling wraps the vector one level deeper.
        let json = serde_json::json!([{"index": 0, "embedding": [[0.7, 0.8]]}]);
        let out = parse_embedding_response(&json, 1).unwrap();
        assert_eq!(out[0], vec![0.7f32, 0.8]);
    }

    #[test]
    fn parse_embedding_rejects_short_or_empty() {
        let json = serde_json::json!([{"embedding": [1.0]}]);
        assert!(parse_embedding_response(&json, 2).is_err());
        let empty = serde_json::json!([{"embedding": []}]);
        assert!(parse_embedding_response(&empty, 1).is_err());
        let not_arr = serde_json::json!({"embedding": [1.0]});
        assert!(parse_embedding_response(&not_arr, 1).is_err());
    }
}
