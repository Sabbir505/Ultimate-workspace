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

// ---- GGUF scanner types ----

#[derive(Debug, Clone)]
pub struct GgufMeta {
    pub name: Option<String>,
    pub architecture: Option<String>,
    pub param_count_label: Option<String>,
    pub quantization: Option<String>,
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
                let mut arr_header = [0u8; 4 + 4]; // type + count
                if file.read_exact(&mut arr_header).is_ok() {
                    let _arr_type = u32::from_le_bytes([arr_header[0], arr_header[1], arr_header[2], arr_header[3]]);
                    let arr_count = u32::from_le_bytes([arr_header[4], arr_header[5], arr_header[6], arr_header[7]]) as u64;
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

/// Recursively scan a directory for `.gguf` files.
pub fn scan_folder(dir: &Path, source: &str) -> Vec<GgufFile> {
    let mut files = Vec::new();
    let walker = match walkdir::WalkDir::new(dir).max_depth(6).into_iter().collect::<Result<Vec<_>, _>>() {
        Ok(entries) => entries,
        Err(_) => return files,
    };

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
            continue;
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

pub struct SidecarHandle {
    pub child: tokio::process::Child,
    pub port: u16,
    pub model_id: String,
    /// The effective context window (`-c`) the sidecar was launched with. The
    /// compaction framework reads this (via `status()`) so its threshold is
    /// always relative to the window the model actually has, not a hardcoded
    /// constant.
    pub n_ctx: u32,
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

    /// Start a llama-server sidecar for the given model. Stops any existing
    /// sidecar first (v1: one at a time, though the data structure supports N).
    pub async fn start(
        &self,
        model_id: String,
        gguf_path: &str,
        ngl_override: Option<i32>,
        ctx_override: Option<u32>,
        mmproj_path: Option<&str>,
    ) -> Result<StartedModel, String> {
        // Stop any running sidecar.
        self.stop_all().await;

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

        // Auto-detect GPU layers.
        let ngl = ngl_override.unwrap_or_else(|| auto_ngl());

        // Auto-pick context size.
        let ctx = ctx_override.unwrap_or_else(|| auto_ctx_size(gguf_path));

        // Spawn llama-server. We deliberately do NOT pass `--flash-attn`: it is
        // a perf optimization, not required for correctness, and support varies
        // by build (CUDA-only on some, absent on older/CPU-only builds). An
        // unsupported flag fails at RUNTIME (the process spawns, then exits
        // with an "unrecognized argument" error) — NOT at `spawn()` time — so a
        // spawn-time retry can't catch it, and the failure would only surface
        // as a health-check timeout. Omitting it keeps the default path
        // universal and fast. (A future iteration can add it as an opt-in once
        // we detect a CUDA/Metal build.)
        let mut cmd = tokio::process::Command::new(&bin);
        // Build the arg list dynamically — --mmproj is optional (only passed
        // when a vision projector companion was found next to the model).
        let mut args: Vec<String> = vec![
            "--model".to_string(), gguf_path.to_string(),
            "--port".to_string(), port.to_string(),
            "--host".to_string(), "127.0.0.1".to_string(),
            "--n-gpu-layers".to_string(), ngl.to_string(),
            "-c".to_string(), ctx.to_string(),
        ];
        if let Some(mp) = mmproj_path {
            if !mp.is_empty() {
                args.push("--mmproj".to_string());
                args.push(mp.to_string());
            }
        }
        cmd.args(&args)
        .current_dir(&resolved.dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

        // On Windows, suppress the child's console window. In a production
        // (release) Tauri build the app has no console of its own, so spawning
        // a console subprocess like llama-server.exe causes Windows to allocate
        // a brand-new visible console for the child. The user sees a terminal
        // pop up, and closing it kills llama-server — which silently breaks the
        // local model. CREATE_NO_WINDOW keeps the process fully backgrounded.
        // The dev build already inherits the parent's console so this is a
        // no-op there, but applying it unconditionally is harmless and keeps
        // dev/prod behavior consistent.
        #[cfg(windows)]
        {
            // tokio::process::Command exposes `creation_flags` as an inherent
            // method (it forwards to the inner std Command), so no trait import
            // is needed here — unlike the std::process::Command call sites in
            // git.rs / harness_adapters, which must import CommandExt.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        // CUDA DLL path injection: a source-built llama.cpp with CUDA support
        // links `ggml-cuda.dll`, which in turn needs the NVIDIA CUDA runtime
        // DLLs (cudart64_*.dll, cublas64_*.dll, cublasLt64_*.dll, …). Those live
        // in the CUDA Toolkit's `bin` dir, which Windows does NOT search by
        // default — so the child exits with 0xC0000135 (STATUS_DLL_NOT_FOUND)
        // before producing any output. Prepend the resolved CUDA bin to the
        // child's PATH so the DLLs resolve. No-op on non-Windows / no CUDA.
        if let Some(cuda_bin) = cuda_toolkit_bin() {
            let existing_path = std::env::var("PATH").unwrap_or_default();
            let new_path = if existing_path.is_empty() {
                cuda_bin.to_string_lossy().to_string()
            } else {
                format!("{};{}", cuda_bin.to_string_lossy(), existing_path)
            };
            cmd.env("PATH", new_path);
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!("failed to spawn llama-server at {bin}: {e}. \
                     Install llama.cpp and ensure llama-server is on PATH, or set LLAMA_SERVER_PATH.")
        })?;

        // Health-check: poll GET /health. The timeout scales with model size
        // because startup is dominated by reading the GGUF from disk — a ~4GB
        // file on a slow/nearly-full drive needs well over 30s just to map
        // vocab + tensors (observed: 23s to load the vocab alone). Base 30s +
        // 15s per GB, capped at 180s. Bail early if the child has already
        // exited — that means startup failed fast (bad flag, unsupported
        // architecture, missing model file) rather than the model just taking
        // time to load. Surfacing stderr immediately keeps a broken model from
        // burning the full timeout budget.
        let timeout_secs: u64 = {
            let gb = fs::metadata(gguf_path)
                .map(|m| m.len())
                .unwrap_or(0) as f64
                / (1024.0 * 1024.0 * 1024.0);
            (30.0 + gb * 15.0).clamp(30.0, 180.0) as u64
        };
        let health_url = format!("http://127.0.0.1:{port}/health");
        let client = reqwest::Client::new();
        let mut ready = false;
        for _ in 0..timeout_secs * 2 {
            // If the process died, /health will never answer. Give the pipes a
            // moment to flush (llama-server buffers), then drain BOTH stdout and
            // stderr — the load error (e.g. "unsupported model architecture:
            // 'clip'") is usually on stdout, not stderr.
            match child.try_wait() {
                Ok(Some(_status)) => {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let output = take_streams(&mut child).await;
                    return Err(format!(
                        "llama-server exited during startup.\n{output}"
                    ));
                }
                Ok(None) => {} // still running — keep polling
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

        if !ready {
            // Kill the process and collect stdout+stderr for diagnostics.
            let _ = child.kill().await;
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            let output = take_streams(&mut child).await;
            let _ = child.wait().await;
            return Err(format!(
                "llama-server did not become healthy within {timeout_secs}s.\n{output}"
            ));
        }

        let handle = SidecarHandle {
            child,
            port,
            model_id: model_id.clone(),
            n_ctx: ctx,
        };
        self.handles.lock().insert(model_id.clone(), handle);

        Ok(StartedModel {
            model_id,
            port,
            n_ctx: ctx,
            base_url: format!("http://127.0.0.1:{port}"),
        })
    }

    /// Stop a specific sidecar by model_id.
    pub async fn stop(&self, model_id: &str) {
        let handle = self.handles.lock().remove(model_id);
        if let Some(mut h) = handle {
            let _ = h.child.kill().await;
            let _ = h.child.wait().await;
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

    /// Return status of the first running sidecar (v1: at most one).
    pub fn status(&self) -> Option<ActiveLocalModel> {
        self.handles.lock().values().next().map(|h| ActiveLocalModel {
            model_id: h.model_id.clone(),
            port: h.port,
            n_ctx: h.n_ctx,
            base_url: format!("http://127.0.0.1:{}", h.port),
        })
    }
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
    pub base_url: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveLocalModel {
    pub model_id: String,
    pub port: u16,
    pub n_ctx: u32,
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

    // 3. Common install locations. On Windows this includes source-build trees
    // (which carry sibling DLLs) on all drives — llama.cpp is frequently built
    // under D:\, E:\, etc. rather than C:\.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        candidates.push(PathBuf::from(r"C:\llama.cpp\build\bin\Release\llama-server.exe"));
        candidates.push(PathBuf::from(r"C:\llama.cpp\build\bin\llama-server.exe"));
        // Source builds on any drive: D:\LLMACPP\llama.cpp\build\bin\llama-server.exe
        // and the bare llama.cpp layout under the drive root.
        for drive in ['D', 'E', 'F', 'G'] {
            candidates.push(PathBuf::from(format!("{drive}:\\LLMACPP\\llama.cpp\\build\\bin\\llama-server.exe")));
            candidates.push(PathBuf::from(format!("{drive}:\\llama.cpp\\build\\bin\\llama-server.exe")));
            candidates.push(PathBuf::from(format!("{drive}:\\llama.cpp\\build\\bin\\Release\\llama-server.exe")));
        }
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

fn auto_ngl() -> i32 {
    // Default to offloading all layers. llama-server clamps to available GPU
    // memory gracefully if it can't allocate, and falls back to CPU for the
    // rest. A future iteration could use sysinfo's Components to detect CUDA
    // or Metal devices.
    999
}

fn auto_ctx_size(gguf_path: &str) -> u32 {
    // Read the file size. Very small models (< 4GB) get 16384; medium models
    // (4-16GB) get 8192; large models get 4096. KV-cache memory scales with
    // ctx but stays modest at these tiers even on CPU-only machines, and
    // 4096 proved too small in practice — a medium-length chat already
    // overflows it (llama-server then rejects the request with a 400).
    // The model's own config.json (if separate) could provide a better
    // max_seq_len, but the GGUF file size is a reliable fallback.
    let size = match fs::metadata(gguf_path) {
        Ok(m) => m.len(),
        Err(_) => return 16384,
    };
    let gb = size as f64 / (1024.0 * 1024.0 * 1024.0);
    if gb < 4.0 {
        16384
    } else if gb < 16.0 {
        8192
    } else {
        4096
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
