//! Speech-to-text (voice input) model management — the STT analog of the
//! local-LLM sidecar system. Three pieces:
//!
//! 1. **Curated model catalog** — a small fixed list of whisper.cpp GGML
//!    models (quantized `.bin` files on Hugging Face) the user can download
//!    through the shared Model-Market download engine (`start_model_download`
//!    takes any URL/dest-dir; only the catalog *search* is GGUF-specific).
//!    Files land in `<models dir>/stt/`.
//! 2. **whisper-server sidecar** — resolve the binary (user-set path → env →
//!    PATH → bundled dir → common locations), spawn it against the default
//!    model on a free port, health-poll, and expose start/stop/status.
//!    Mirrors the llama-server lifecycle but simpler: one model per server,
//!    no GPU-layer ladder (STT models here are CPU-sized by design — they
//!    must coexist with a loaded LLM on the same GPU).
//! 3. **Settings** — `stt.defaultModel`, `stt.autoStart`, and the binary
//!    path override `stt.whisperServerPath`, all in `app_settings`.
//!
//! `transcribe_audio` (commands/speech.rs) prefers the RUNNING sidecar's
//! `/inference` endpoint over any external `whisper.baseUrl`.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager, State};

use crate::commands::local_model_market::DownloadState;
use crate::db;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// Where downloaded STT models live, relative to the configured models dir.
pub const STT_SUBDIR: &str = "stt";

const DEFAULT_MODEL_KEY: &str = "stt.defaultModel";
const AUTO_START_KEY: &str = "stt.autoStart";
const SERVER_PATH_KEY: &str = "stt.whisperServerPath";

/// One curated whisper.cpp model. `size_bytes` is approximate (the download
/// engine streams the real content-length; this only powers the UI label).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttModelInfo {
    pub id: String,
    pub label: String,
    pub filename: String,
    pub download_url: String,
    pub size_bytes: u64,
    pub note: String,
    pub recommended: bool,
}

/// Curated catalog — quantized whisper.cpp GGML builds from the official
/// `ggerganov/whisper.cpp` repo (NOTE: `ggml-org/whisper.cpp` does NOT exist —
/// HF answers 401 for unknown repos, which the downloader surfaced as a
/// misleading "gated" error). `large-v3-turbo` is included for users whose
/// GPU has headroom; the small/base quants are the CPU-friendly picks.
pub fn catalog() -> Vec<SttModelInfo> {
    const HF: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
    vec![
        SttModelInfo {
            id: "stt/ggml-small-q5_1".into(),
            label: "Whisper Small (Q5_1)".into(),
            filename: "ggml-small-q5_1.bin".into(),
            download_url: format!("{HF}/ggml-small-q5_1.bin"),
            size_bytes: 181_393_335,
            note: "Recommended — best accuracy that still runs real-time on CPU, leaving your GPU to the LLM".into(),
            recommended: true,
        },
        SttModelInfo {
            id: "stt/ggml-base-q5_1".into(),
            label: "Whisper Base (Q5_1)".into(),
            filename: "ggml-base-q5_1.bin".into(),
            download_url: format!("{HF}/ggml-base-q5_1.bin"),
            size_bytes: 61_946_135,
            note: "Lightest sensible — for older CPUs; accuracy takes a hit".into(),
            recommended: false,
        },
        SttModelInfo {
            id: "stt/ggml-large-v3-turbo-q5_0".into(),
            label: "Whisper Large v3 Turbo (Q5_0)".into(),
            filename: "ggml-large-v3-turbo-q5_0.bin".into(),
            download_url: format!("{HF}/ggml-large-v3-turbo-q5_0.bin"),
            size_bytes: 547_161_927,
            note: "Best quality — needs ~1.5GB VRAM free (not while a big LLM is loaded)".into(),
            recommended: false,
        },
    ]
}

/// A running whisper-server sidecar. The child is kept so `stop` can kill it;
/// dropped only on stop/app exit (whisper-server dies with the app — same
/// lifecycle contract as the llama sidecar).
pub struct SttHandle {
    pub port: u16,
    pub model_path: String,
    pub child: tokio::process::Child,
}

#[derive(Default)]
pub struct SttState(pub Mutex<Option<SttHandle>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub model_path: Option<String>,
    /// Resolved whisper-server binary, when found.
    pub binary_path: Option<String>,
    pub default_model: Option<String>,
    pub auto_start: bool,
    /// Absolute dir downloads target (`<models dir>/stt`).
    pub stt_dir: Option<String>,
    pub catalog: Vec<SttCatalogEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttCatalogEntry {
    pub id: String,
    pub label: String,
    pub filename: String,
    pub download_url: String,
    pub size_bytes: u64,
    pub note: String,
    pub recommended: bool,
    pub installed: bool,
    pub is_default: bool,
}

fn stt_dir(conn: &rusqlite::Connection) -> Option<PathBuf> {
    crate::commands::local_model_market::resolve_models_dir(conn)
        .ok()
        .map(|d| d.join(STT_SUBDIR))
}

fn get_setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    db::get_setting(conn, key).ok().flatten()
}

/// Resolve the whisper-server binary: user-set path (file or directory) →
/// `WHISPER_SERVER` env → PATH → bundled sidecar dir (future-proof: shipped
/// alongside llama-server) → common build locations.
fn resolve_binary(conn: &rusqlite::Connection) -> Option<PathBuf> {
    const EXE: &str = if cfg!(windows) { "whisper-server.exe" } else { "whisper-server" };

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = get_setting(conn, SERVER_PATH_KEY).filter(|s| !s.trim().is_empty()) {
        let path = PathBuf::from(p.trim());
        if path.is_file() {
            candidates.push(path);
        } else if path.is_dir() {
            candidates.push(path.join(EXE));
        }
    }
    if let Ok(env_path) = std::env::var("WHISPER_SERVER") {
        let path = PathBuf::from(env_path);
        if path.is_file() {
            candidates.push(path);
        } else if path.is_dir() {
            candidates.push(path.join(EXE));
        }
    }
    if let Some(dir) = crate::chat::local_models::bundled_llama_server_dir() {
        candidates.push(dir.join(EXE));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            candidates.push(dir.join(EXE));
        }
    }
    for dir in ["C:\\whisper.cpp\\build\\bin", "C:\\whisper.cpp"] {
        candidates.push(PathBuf::from(dir).join(EXE));
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn model_file(stt_dir: &Path, filename: &str) -> PathBuf {
    stt_dir.join(filename)
}

/// Full status snapshot for the Settings panel: catalog + installed flags +
/// default + sidecar state + binary resolution.
#[tauri::command]
pub async fn stt_status(db: State<'_, DbState>, stt: State<'_, SttState>) -> CmdResult<SttStatus> {
    let (dir, default_model, auto_start, binary) = {
        let conn = db.0.lock();
        (
            stt_dir(&conn),
            get_setting(&conn, DEFAULT_MODEL_KEY),
            get_setting(&conn, AUTO_START_KEY).as_deref() == Some("true"),
            resolve_binary(&conn),
        )
    };
    let running_guard = stt.0.lock();
    let catalog = catalog()
        .into_iter()
        .map(|m| {
            let installed = dir
                .as_ref()
                .map(|d| model_file(d, &m.filename).is_file())
                .unwrap_or(false);
            let is_default = default_model.as_deref() == Some(m.filename.as_str())
                || (default_model.is_none() && m.recommended && installed);
            SttCatalogEntry {
                id: m.id,
                label: m.label,
                filename: m.filename,
                download_url: m.download_url,
                size_bytes: m.size_bytes,
                note: m.note,
                recommended: m.recommended,
                installed,
                is_default,
            }
        })
        .collect();
    Ok(SttStatus {
        running: running_guard.is_some(),
        port: running_guard.as_ref().map(|h| h.port),
        model_path: running_guard.as_ref().map(|h| h.model_path.clone()),
        binary_path: binary.map(|p| p.to_string_lossy().into_owned()),
        default_model,
        auto_start,
        stt_dir: dir.map(|d| d.to_string_lossy().into_owned()),
        catalog,
    })
}

/// The effective default model path: the `stt.defaultModel` file if present,
/// else the only/recommended installed model. `None` when nothing is installed.
fn resolve_default_model_path(dir: &Path, default_model: Option<&str>) -> Option<PathBuf> {
    if let Some(name) = default_model {
        let p = model_file(dir, name);
        if p.is_file() {
            return Some(p);
        }
    }
    // Fall back: recommended first, then any installed.
    for m in catalog() {
        if m.recommended {
            let p = model_file(dir, &m.filename);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let mut others: Vec<PathBuf> = catalog()
        .iter()
        .map(|m| model_file(dir, &m.filename))
        .filter(|p| p.is_file())
        .collect();
    others.sort();
    others.into_iter().next()
}

fn pick_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(8915)
}

/// Spawn + health-wait shared by the `stt_start` command and the lazy-start
/// path inside `transcribe_audio` (mic press self-heals when binary+model are
/// present). Assumes nothing is running — callers check `SttState` first.
/// Returns the port the sidecar came up on.
pub async fn start_sidecar_core(db: &DbState, stt: &SttState) -> CmdResult<u16> {
    let (dir, default_model, binary) = {
        let conn = db.0.lock();
        (
            stt_dir(&conn).ok_or("Models directory is not configured")?,
            get_setting(&conn, DEFAULT_MODEL_KEY),
            resolve_binary(&conn),
        )
    };
    let binary = binary.ok_or(
        "whisper-server is not installed — open Settings → Local Models → Speech and click Install",
    )?;
    let model_path = resolve_default_model_path(&dir, default_model.as_deref()).ok_or(
        "No speech model installed — download one in Settings → Local Models → Speech first",
    )?;

    let port = pick_free_port();
    // whisper.cpp defaults to 4 inference threads regardless of core count;
    // handing it every logical core typically halves-to-quarters latency on
    // desktop parts (STT bursts only — it idles between clips).
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let mut cmd = tokio::process::Command::new(&binary);
    cmd.args([
        "-m".to_string(),
        model_path.to_string_lossy().into_owned(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--threads".to_string(),
        threads.to_string(),
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to start whisper-server: {e}"))?;

    // Health-poll: any HTTP response from the port means the server is up
    // (whisper.cpp answers 404 on unknown paths — a response is the signal).
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_millis(700))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}/");
    let mut healthy = false;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if client.get(&url).send().await.is_ok() {
            healthy = true;
            break;
        }
    }
    if !healthy {
        // Take the handle out under the lock, drop the guard, THEN kill —
        // the parking_lot guard must never be held across an await (the
        // command future has to stay Send).
        let mut handle = stt.0.lock().take();
        if let Some(h) = handle.as_mut() {
            let _ = h.child.kill().await;
        }
        return Err("whisper-server started but never became reachable (check the model file / binary build)".into());
    }

    *stt.0.lock() = Some(SttHandle {
        port,
        model_path: model_path.to_string_lossy().into_owned(),
        child,
    });
    eprintln!("[stt] whisper-server up on port {port} (model {})", model_path.display());

    // GPU servers JIT-compile their kernels on the FIRST inference (~30-60s
    // on Turing) — fire a tiny silent clip in the background so that cost
    // lands at startup, not in the middle of the user's first dictation.
    // Fire-and-forget: failures here are harmless (CPU builds warm in ms).
    let warm_url = format!("http://127.0.0.1:{port}/inference");
    tauri::async_runtime::spawn(async move {
        let mut wav = Vec::with_capacity(44 + 3200);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&36u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&32000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&3200u32.to_le_bytes()); // 0.1s of silence
        wav.extend_from_slice(&[0u8; 3200]);
        let Ok(part) = reqwest::multipart::Part::bytes(wav)
            .file_name("warmup.wav")
            .mime_str("audio/wav")
        else {
            return;
        };
        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("response_format", "json");
        let warm_client = match reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(180))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let _ = warm_client.post(&warm_url).multipart(form).send().await;
        eprintln!("[stt] sidecar warmup complete");
    });
    Ok(port)
}

/// Start the whisper-server sidecar (Settings button). No-op when already
/// running; returns the fresh status either way (with the failure reason in
/// `error`).
#[tauri::command]
pub async fn stt_start(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    stt: State<'_, SttState>,
) -> CmdResult<SttStatus> {
    // Guard-free check: the temporary drops at the `let` — a parking_lot
    // MutexGuard is !Send, so it must never be in scope across an await.
    let already_running = stt.0.lock().is_some();
    if already_running {
        return stt_status(db, stt).await;
    }
    start_sidecar_core(&db, &stt).await?;
    let _ = app; // reserved for status events
    stt_status(db, stt).await
}

#[tauri::command]
pub async fn stt_stop(stt: State<'_, SttState>) -> CmdResult<()> {
    // Take out under the lock, drop the guard, then kill (Send future).
    let mut handle = stt.0.lock().take();
    if let Some(h) = handle.as_mut() {
        let _ = h.child.kill().await;
    }
    Ok(())
}

#[tauri::command]
pub fn stt_set_default(db: State<'_, DbState>, filename: String) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_setting(&conn, DEFAULT_MODEL_KEY, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stt_set_auto_start(db: State<'_, DbState>, auto_start: bool) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_setting(&conn, AUTO_START_KEY, if auto_start { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stt_set_server_path(db: State<'_, DbState>, path: Option<String>) -> CmdResult<()> {
    let conn = db.0.lock();
    match path {
        Some(p) if !p.trim().is_empty() => {
            db::set_setting(&conn, SERVER_PATH_KEY, p.trim()).map_err(|e| e.to_string())
        }
        _ => db::set_setting(&conn, SERVER_PATH_KEY, "").map_err(|e| e.to_string()),
    }
}

/// App-boot auto-start: spawn the sidecar when the user opted in, the default
/// model is installed, and the binary resolves. Best-effort — failures log and
/// return; the mic button's toast flow surfaces the reason on first use.
pub fn maybe_autostart(app: &tauri::AppHandle, db: &DbState) {
    let (auto_start, dir, default_model, binary) = {
        let conn = db.0.lock();
        (
            get_setting(&conn, AUTO_START_KEY).as_deref() == Some("true"),
            stt_dir(&conn),
            get_setting(&conn, DEFAULT_MODEL_KEY),
            resolve_binary(&conn),
        )
    };
    if !auto_start {
        return;
    }
    let (Some(dir), Some(binary)) = (dir, binary) else {
        eprintln!("[stt] auto-start skipped: no models dir or whisper-server binary");
        return;
    };
    if resolve_default_model_path(&dir, default_model.as_deref()).is_none() {
        eprintln!("[stt] auto-start skipped: default model file missing");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let db = app.state::<DbState>();
        let stt = app.state::<SttState>();
        match stt_start(app.clone(), db, stt).await {
            Ok(s) if s.running => eprintln!("[stt] auto-started on port {:?}", s.port),
            Ok(_) => {}
            Err(e) => eprintln!("[stt] auto-start failed: {e}"),
        }
    });
}

/// Base URL of the running sidecar, for `transcribe_audio` to prefer.
pub fn active_base_url(stt: &SttState) -> Option<String> {
    stt.0.lock().as_ref().map(|h| format!("http://127.0.0.1:{}", h.port))
}

// ---- One-click whisper-server install ----
//
// Most users have no whisper.cpp build — the mic is dead until a binary
// exists. This downloads the pinned upstream release zip (prebuilt CPU
// binaries, ~8 MB, includes whisper-server.exe + its ggml/whisper DLLs),
// extracts it into <app data>/bin/whisper-cpp/, and saves the resolved exe
// path into `stt.whisperServerPath` — first priority in `resolve_binary`, so
// Start server works immediately after. Progress flows over the SAME event
// stream the model market uses (`local-model:download:progress`) so the
// settings panel renders it with zero new frontend plumbing.

/// Pinned whisper.cpp release tag. Pinned (not `latest/download`) so the asset
/// name/contents can never shift under us; bump deliberately when upgrading.
const WHISPER_RELEASE_TAG: &str = "b4938";
#[cfg(windows)]
const WHISPER_ZIP_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip";

/// Progress-event id for the server install (distinct from model ids).
pub const SERVER_INSTALL_ID: &str = "stt-whisper-server";

fn emit_progress(app: &tauri::AppHandle, state: crate::commands::local_model_market::DownloadState, downloaded: u64, total: Option<u64>, final_path: Option<String>, error: Option<String>) {
    let _ = app.emit(
        "local-model:download:progress",
        crate::commands::local_model_market::DownloadProgress {
            id: SERVER_INSTALL_ID.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            state,
            bytes_per_second: 0.0,
            final_path,
            error,
        },
    );
}

/// Directory the managed install extracts into.
fn managed_install_dir(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("bin")
        .join("whisper-cpp");
    Ok(dir)
}

#[tauri::command]
pub async fn stt_install_server(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    stt: State<'_, SttState>,
) -> CmdResult<SttStatus> {
    #[cfg(not(windows))]
    {
        let _ = (&app, &db, &stt);
        return Err(
            "one-click install is Windows-only right now — set your whisper-server path below instead"
                .into(),
        );
    }

    #[cfg(windows)]
    {
        use futures_util::StreamExt;

        // Idempotent: if the managed install already exists just re-point the
        // setting at it (repairs a cleared/edited path without re-downloading).
        let install_dir = managed_install_dir(&app)?;
        let exe_path = install_dir.join("whisper-server.exe");
        if !exe_path.is_file() {
            std::fs::create_dir_all(&install_dir)
                .map_err(|e| format!("could not create install dir: {e}"))?;
            emit_progress(&app, DownloadState::Starting, 0, None, None, None);

            // Stream to a temp file next to the destination with throttled
            // progress events (same 150ms cadence as the model downloader).
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(300))
                .build()
                .map_err(|e| e.to_string())?;
            let resp = client
                .get(WHISPER_ZIP_URL)
                .header("User-Agent", "conduit-stt-install")
                .send()
                .await
                .map_err(|e| format!("download failed: {e}"))?;
            if !resp.status().is_success() {
                let msg = format!(
                    "download failed: HTTP {} from {WHISPER_ZIP_URL}",
                    resp.status()
                );
                emit_progress(&app, DownloadState::Error, 0, None, None, Some(msg.clone()));
                return Err(msg);
            }
            let total = resp.content_length();
            let zip_path = std::env::temp_dir().join(format!("conduit-whisper-{WHISPER_RELEASE_TAG}.zip"));
            let mut file = tokio::fs::File::create(&zip_path)
                .await
                .map_err(|e| format!("could not write temp file: {e}"))?;
            let mut stream = resp.bytes_stream();
            let mut downloaded: u64 = 0;
            let mut last_emit = std::time::Instant::now();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| {
                    let msg = format!("download failed mid-stream: {e}");
                    emit_progress(&app, DownloadState::Error, downloaded, total, None, Some(msg.clone()));
                    msg
                })?;
                tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                    .await
                    .map_err(|e| format!("could not write temp file: {e}"))?;
                downloaded += chunk.len() as u64;
                if last_emit.elapsed().as_millis() >= 150 {
                    last_emit = std::time::Instant::now();
                    emit_progress(&app, DownloadState::Downloading, downloaded, total, None, None);
                }
            }
            tokio::io::AsyncWriteExt::flush(&mut file)
                .await
                .map_err(|e| format!("could not flush temp file: {e}"))?;
            drop(file);

            // Extract only what we need (exes + DLLs), flattened into the
            // install dir — the zip nests everything under Release/, and
            // whisper-server.exe needs its sibling ggml*/whisper*.dll files.
            emit_progress(&app, DownloadState::Verifying, downloaded, total, None, None);
            let extract_dir = install_dir.clone();
            let extract_zip = zip_path.clone();
            let extracted = tauri::async_runtime::spawn_blocking(move || -> Result<u32, String> {
                let reader = std::fs::File::open(&extract_zip)
                    .map_err(|e| format!("could not open downloaded zip: {e}"))?;
                let mut archive = zip::ZipArchive::new(reader)
                    .map_err(|e| format!("bad zip archive: {e}"))?;
                let mut count = 0u32;
                for i in 0..archive.len() {
                    let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
                    if entry.is_dir() {
                        continue;
                    }
                    let name = entry.name().to_string();
                    if !(name.ends_with(".exe") || name.ends_with(".dll")) {
                        continue;
                    }
                    let base = name.rsplit(['/', '\\']).next().unwrap_or(&name).to_string();
                    let out = extract_dir.join(&base);
                    let mut out_file = std::fs::File::create(&out)
                        .map_err(|e| format!("could not write {base}: {e}"))?;
                    std::io::copy(&mut entry, &mut out_file)
                        .map_err(|e| format!("could not extract {base}: {e}"))?;
                    count += 1;
                }
                Ok(count)
            })
            .await
            .map_err(|e| format!("extract task failed: {e}"))?;

            let extracted = extracted?;
            eprintln!("[stt] one-click install extracted {extracted} files");

            if !exe_path.is_file() {
                let msg = "downloaded release did not contain whisper-server.exe".to_string();
                emit_progress(&app, DownloadState::Error, downloaded, total, None, Some(msg.clone()));
                return Err(msg);
            }
            let _ = std::fs::remove_file(&zip_path);
        }

        // Point `stt.whisperServerPath` at the managed binary — the top of
        // resolve_binary's chain — then report fresh status. The guard must
        // drop before the awaited stt_status call (parking_lot is !Send).
        {
            let conn = db.0.lock();
            db::set_setting(
                &conn,
                SERVER_PATH_KEY,
                &exe_path.to_string_lossy(),
            )
            .map_err(|e| e.to_string())?;
        }
        emit_progress(
            &app,
            DownloadState::Done,
            0,
            None,
            Some(exe_path.to_string_lossy().into_owned()),
            None,
        );
        stt_status(db, stt).await
    }
}
