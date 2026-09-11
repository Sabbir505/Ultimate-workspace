//! GPU synthesis for read-aloud — the CUDA path for Kokoro.
//!
//! Why this is a child process rather than a setting on the engine in `tts.rs`:
//! the crates.io `sherpa-onnx` build links CPU-only libraries. Asking it for
//! CUDA at runtime logs "Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON.
//! Available providers: CPUExecutionProvider" and silently falls back — an
//! earlier revision shipped a provider toggle that did exactly nothing, which is
//! why there is no "provider" setting anywhere in the UI. GPU instead runs the
//! vendor's CUDA build of `sherpa-onnx-offline-tts`, published as a
//! self-contained tar.bz2, as a short-lived child process.
//!
//! Measured on a GTX 1660 Ti (Turing) with the multilingual Kokoro model, same
//! sentence, best of three:
//!
//! ```text
//!              synthesis (9.49s audio)        incl. process start + model load
//! CPU 6 thr    6.37s   1.49x realtime        10.10s   0.94x realtime
//! CUDA         2.08s   4.56x realtime         6.56s   1.45x realtime
//! ```
//!
//! So the GPU synthesizes ~3x faster but pays roughly 4.5s of start-up per
//! invocation. That is why the player requests LARGER chunks when the device is
//! GPU (see `chunkBudget` in src/lib/tts.ts): one model load per sentence would
//! spend 4.5s loading for every couple of seconds of audio.
//!
//! The CUDA build needs CUDA and cuDNN *runtime DLLs* that it does not ship.
//! cuDNN comes from NVIDIA's own PyPI redistribution (a wheel — extracted, never
//! installed into Python); the CUDA runtime is located from an existing toolkit
//! installation.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{State};

use super::local_model_market::DownloadState;
use super::tts::{emit_progress, http_client, kokoro_paths, tts_threads};
use crate::db;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// `"cpu"` (in-process engine) or `"gpu"` (CUDA child process).
pub const DEVICE_KEY: &str = "tts.device";
/// Remembered install location of the CUDA runtime, once installed.
pub const GPU_DIR_KEY: &str = "tts.gpuDir";

/// Progress id shared by both halves of the GPU runtime install.
pub const GPU_INSTALL_ID: &str = "tts-gpu-runtime";

/// Pinned CUDA build. The version pairing is a compatibility contract: this
/// archive is built against CUDA 13.x + cuDNN 9.x, so the match strings in the
/// URL, the cuDNN wheel below, and `detect_cuda_runtime`'s `cudart64_13.dll`
/// probe all move together.
const GPU_BUNDLE_DIR: &str =
    "sherpa-onnx-v1.13.8-cuda-13.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda";
const GPU_BUNDLE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-cuda-13.x-cudnn-9.x-onnxruntime1.28.2-win-x64-cuda.tar.bz2";
/// SECURITY: this download is *executed*, so TLS alone is not enough — a
/// compromised CDN or a repointed release asset would otherwise install and run
/// arbitrary code. Verified before extraction; bump together with the URL.
const GPU_BUNDLE_SHA256: &str =
    "1702e4a1ee68a07422469a7ec1d304a54b43a345ad888daf8e0b0257004a3273";
/// Archive size (bytes) — the progress bar's denominator before headers arrive.
const GPU_BUNDLE_SIZE: u64 = 478_110_488;

/// cuDNN 9 runtime for CUDA 13, from NVIDIA's PyPI redistribution. `files.`
/// URLs are content-addressed and immutable, so this pin is stable (and was
/// verified against the digest PyPI itself reports).
const CUDNN_WHEEL_URL: &str = "https://files.pythonhosted.org/packages/d6/1f/9c5d7ed254d7040192b4bb4eef669ba3ed66a3c4576c50f7d2385b255c8e/nvidia_cudnn_cu13-9.26.0.51-py3-none-win_amd64.whl";
const CUDNN_WHEEL_SHA256: &str =
    "8e37a83d7dd7c2663afcae38b1c95c5e9e7c9754f313800da95ca81439fa37f9";
const CUDNN_WHEEL_SIZE: u64 = 419_603_885;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsGpuStatus {
    /// The CUDA engine binary is on disk.
    pub installed: bool,
    pub exe_path: Option<String>,
    /// Detected CUDA toolkit runtime directory (holds cudart/cublas DLLs).
    pub cuda_runtime: Option<String>,
    /// cuDNN 9 has been extracted.
    pub cudnn: bool,
    pub root: String,
    /// Human-readable list of what is still missing; empty when GPU is ready.
    pub missing: Vec<String>,
}

pub fn gpu_root(app: &tauri::AppHandle) -> PathBuf {
    crate::user_dirs::app_data_dir(app)
        .join("bin")
        .join("sherpa-onnx-cuda")
}

fn gpu_exe(root: &Path) -> Option<PathBuf> {
    let exe = root
        .join(GPU_BUNDLE_DIR)
        .join("bin")
        .join("sherpa-onnx-offline-tts.exe");
    exe.is_file().then_some(exe)
}

fn gpu_cudnn_dir(root: &Path) -> PathBuf {
    root.join("cudnn")
}

fn gpu_bin_dir(root: &Path) -> PathBuf {
    root.join(GPU_BUNDLE_DIR).join("bin")
}

/// Locate the CUDA toolkit's runtime DLL directory. Recent toolkits put the
/// runtime in `bin/x64`, older ones directly in `bin`; the newest version wins
/// when several are installed.
fn detect_cuda_runtime() -> Option<PathBuf> {
    let base = PathBuf::from(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(&base)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    versions.sort();
    versions.reverse();
    for version in versions {
        for candidate in [version.join("bin").join("x64"), version.join("bin")] {
            if candidate.join("cudart64_13.dll").is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn gpu_status_of(root: &Path) -> TtsGpuStatus {
    let exe = gpu_exe(root);
    let cuda_runtime = detect_cuda_runtime();
    let cudnn = gpu_cudnn_dir(root).join("cudnn64_9.dll").is_file();
    let mut missing = Vec::new();
    if exe.is_none() {
        missing.push("the CUDA voice engine".to_string());
    }
    if cuda_runtime.is_none() {
        missing.push("the NVIDIA CUDA 13 runtime".to_string());
    }
    if !cudnn {
        missing.push("the cuDNN 9 runtime".to_string());
    }
    TtsGpuStatus {
        installed: exe.is_some(),
        exe_path: exe.map(|p| p.to_string_lossy().into_owned()),
        cuda_runtime: cuda_runtime.map(|p| p.to_string_lossy().into_owned()),
        cudnn,
        root: root.to_string_lossy().into_owned(),
        missing,
    }
}

/// Streaming SHA-256 of a file, lowercase hex.
fn sha256_file_hex(path: &Path) -> CmdResult<String> {
    use sha2::Digest;
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("could not open download: {e}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("could not read download: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Whether an existing `.part` file can be resumed, i.e. whether asking for
/// `Range: bytes=<have>-` will be satisfiable.
///
/// A partial at or past the expected size is NOT resumable: asking for a range
/// that starts at or beyond the end is what earns a 416. `expected == 0` means
/// the size is unknown, in which case any non-empty partial is worth trying.
///
/// This is the decision that a real install got wrong — a doubled partial
/// (a proxy answering a ranged request with the whole body) made every retry
/// ask for an impossible range, and 416 was treated as fatal.
fn partial_is_resumable(have: u64, expected_size: u64) -> bool {
    have > 0 && (expected_size == 0 || have < expected_size)
}

/// Whether a completed transfer is plausibly the whole artifact. A body that
/// ends early (a proxy closing cleanly at the wrong length) looks exactly like
/// success at the pump level, so the length is checked before spending a SHA
/// pass — and a mismatch is retried rather than reported as corruption.
fn length_is_expected(written: u64, expected_size: u64) -> bool {
    expected_size == 0 || written == expected_size
}

/// Attempts before giving up on a large artifact. A 400+ MB fetch over a
/// consumer connection regularly drops once, and the failure a user actually hit
/// was exactly that: a transient request error with no retry, so a 420 MB
/// download was reported as a hard failure with nothing kept.
const DOWNLOAD_ATTEMPTS: u32 = 4;
/// No data for this long means the connection is dead rather than slow. The pump
/// measures between chunks, not the whole transfer.
const DOWNLOAD_STALL: std::time::Duration = std::time::Duration::from_secs(60);

/// Exponential backoff between attempts (2s, 4s, 8s…), capped so a genuinely
/// offline machine fails in a reasonable time instead of hanging.
async fn download_backoff(attempt: u32) {
    let secs = 2u64.saturating_pow(attempt.min(4));
    tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
}

/// Stream a pinned artifact to `dest`, verifying its SHA-256 before the file
/// gets its final name.
///
/// Retries with **resume**: the partial file is kept between attempts and the
/// next request asks for the remainder via a `Range` header, so a drop at 90%
/// costs the last 10% rather than the whole download. If the server ignores the
/// range and answers 200, the partial is truncated and the fetch restarts
/// cleanly — correctness never depends on the server cooperating.
async fn download_pinned<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    url: &str,
    sha256: &str,
    label: &str,
    expected_size: u64,
    dest: &Path,
) -> CmdResult<()> {
    if dest.is_file() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let client = http_client()?;
    let part = dest.with_extension("part");
    let mut last_error = String::new();

    for attempt in 1..=DOWNLOAD_ATTEMPTS {
        let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        // A partial already at (or past) the expected size cannot be resumed:
        // it is either complete-with-a-failed-final-step or corrupted — and a
        // proxy that answers a ranged request with the WHOLE body makes the
        // append below double it. Both states produce "416 Range Not
        // Satisfiable" on the next request, which is worse than useless: the
        // range is genuinely unsatisfiable. Discard and refetch instead.
        if !partial_is_resumable(have, expected_size) {
            eprintln!(
                "[tts] {label}: discarding a {have}-byte partial (expected {expected_size}) and starting over"
            );
            let _ = std::fs::remove_file(&part);
            have = 0;
        }
        emit_progress(
            app,
            GPU_INSTALL_ID,
            if have > 0 {
                DownloadState::Downloading
            } else {
                DownloadState::Starting
            },
            have,
            Some(expected_size),
            None,
        );
        let mut req = client.get(url);
        if have > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_error = format!("{label}: {e}");
                eprintln!("[tts] {label} attempt {attempt}/{DOWNLOAD_ATTEMPTS} failed to send: {e}");
                if attempt < DOWNLOAD_ATTEMPTS {
                    download_backoff(attempt).await;
                    continue;
                }
                break;
            }
        };
        // A 416 means the server disagrees about where the file ends, so the
        // partial is unusable. That is recoverable — drop it and ask for the
        // whole file, which cannot itself 416.
        if resp.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && have > 0 {
            eprintln!("[tts] {label}: server rejected the resume range; restarting the download");
            let _ = std::fs::remove_file(&part);
            last_error = format!("{label}: the resume range was rejected");
            if attempt < DOWNLOAD_ATTEMPTS {
                download_backoff(attempt).await;
                continue;
            }
            break;
        }
        if !resp.status().is_success() {
            // Any other 4xx will not improve by waiting; fail now with the status.
            let msg = format!("{label} download failed: HTTP {} from {url}", resp.status());
            emit_progress(
                app,
                GPU_INSTALL_ID,
                DownloadState::Error,
                have,
                Some(expected_size),
                Some(msg.clone()),
            );
            return Err(msg);
        }
        // Resume ONLY when the server confirms it started exactly where we
        // asked. A 206 whose Content-Range begins elsewhere (or is missing) is
        // how a partial gets doubled: appending a body that does not continue
        // from `have` writes the whole file again on top of itself, and the next
        // attempt then asks for a range past the end — the 416 that broke a real
        // install. Treat confirmation as a precondition, not a nicety.
        let confirmed_offset = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("bytes "))
            .and_then(|v| v.split('-').next())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let resuming = have > 0
            && resp.status() == reqwest::StatusCode::PARTIAL_CONTENT
            && confirmed_offset == Some(have);
        if have > 0 && !resuming {
            eprintln!(
                "[tts] {label}: range start unconfirmed (got {confirmed_offset:?}, wanted {have}); restarting the download"
            );
        }
        let total = if resuming {
            resp.content_length().map(|c| c + have)
        } else {
            resp.content_length()
        };

        // Never fires — this install is not wired to the cancel button (it is a
        // single modal action, not a background transfer the user navigates away
        // from). Bound to a NAME rather than `_` so it stays alive for the pump;
        // a bare `_` would drop the sender and the receiver would read cancelled.
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let mut last_emit = std::time::Instant::now();
        let mut on_chunk = |_chunk: &[u8], downloaded: u64, total: Option<u64>| -> Result<(), String> {
            if last_emit.elapsed().as_millis() >= 150 {
                last_emit = std::time::Instant::now();
                emit_progress(app, GPU_INSTALL_ID, DownloadState::Downloading, downloaded, total, None);
            }
            Ok(())
        };
        let (outcome, _downloaded) = crate::download::pump_body_to_file(
            resp,
            &part,
            have,
            resuming,
            DOWNLOAD_STALL,
            &mut cancel_rx,
            &mut on_chunk,
        )
        .await;

        match outcome {
            crate::download::BodyPumpOutcome::Completed => {
                // Trust but verify the length before spending a SHA pass on it:
                // a body that ended early (a proxy closing cleanly at the wrong
                // length) looks exactly like success here, and catching it as a
                // retry is far cheaper than failing verification afterwards.
                let written = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
                if !length_is_expected(written, expected_size) {
                    last_error =
                        format!("{label}: got {written} bytes, expected {expected_size}");
                    eprintln!("[tts] {label} attempt {attempt}/{DOWNLOAD_ATTEMPTS}: {last_error}");
                    let _ = std::fs::remove_file(&part);
                    if attempt < DOWNLOAD_ATTEMPTS {
                        download_backoff(attempt).await;
                        continue;
                    }
                    break;
                }
                last_error.clear();
                break;
            }
            // A local write failure will not fix itself by retrying.
            crate::download::BodyPumpOutcome::WriteError(e) => {
                let msg = format!("{label}: {e}");
                emit_progress(
                    app,
                    GPU_INSTALL_ID,
                    DownloadState::Error,
                    have,
                    Some(expected_size),
                    Some(msg.clone()),
                );
                return Err(msg);
            }
            other => {
                last_error = format!(
                    "{label}: {}",
                    match other {
                        crate::download::BodyPumpOutcome::Stalled => "the connection stalled".to_string(),
                        crate::download::BodyPumpOutcome::ReadError(e) => e,
                        crate::download::BodyPumpOutcome::Cancelled => "cancelled".to_string(),
                        _ => "transfer interrupted".to_string(),
                    }
                );
                eprintln!("[tts] {label} attempt {attempt}/{DOWNLOAD_ATTEMPTS}: {last_error}");
                if attempt < DOWNLOAD_ATTEMPTS {
                    download_backoff(attempt).await;
                    continue;
                }
            }
        }
    }

    if !last_error.is_empty() {
        // The partial is deliberately kept: the next press of Install resumes.
        let msg = format!(
            "{last_error} (tried {DOWNLOAD_ATTEMPTS} times; the bytes already fetched are kept, so retrying resumes)"
        );
        emit_progress(app, GPU_INSTALL_ID, DownloadState::Error, 0, Some(expected_size), Some(msg.clone()));
        return Err(msg);
    }

    emit_progress(app, GPU_INSTALL_ID, DownloadState::Verifying, 0, Some(expected_size), None);
    let verify_path = part.clone();
    let actual = tauri::async_runtime::spawn_blocking(move || sha256_file_hex(&verify_path))
        .await
        .map_err(|e| format!("verify task failed: {e}"))??;
    if actual != sha256 {
        // A bad digest means the bytes are wrong, so the partial is worthless —
        // delete it, or every retry would "resume" onto corrupt data and fail
        // the same way forever.
        let _ = std::fs::remove_file(&part);
        let msg = format!(
            "{label} failed SHA-256 verification (expected {sha256}, got {actual}). The download was discarded — check your network or retry."
        );
        emit_progress(app, GPU_INSTALL_ID, DownloadState::Error, 0, Some(expected_size), Some(msg.clone()));
        return Err(msg);
    }
    std::fs::rename(&part, dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("could not finalize {label}: {e}")
    })
}

/// Unpack the CUDA engine bundle (tar.bz2).
fn extract_gpu_bundle(archive: &Path, root: &Path) -> CmdResult<()> {
    let file = std::fs::File::open(archive).map_err(|e| format!("could not open bundle: {e}"))?;
    let decoder = bzip2::read::BzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    // `unpack` refuses entries that would escape `root` (absolute paths, `..`),
    // which matters because the archive comes from the network.
    tar.unpack(root)
        .map_err(|e| format!("could not extract the CUDA engine: {e}"))
}

/// Extract just the DLLs from NVIDIA's wheel. A wheel is a plain zip; nothing
/// is installed into Python — the DLLs are placed where the child process can
/// find them and nowhere else.
fn extract_cudnn_dlls(wheel: &Path, dest: &Path) -> CmdResult<u32> {
    let reader =
        std::fs::File::open(wheel).map_err(|e| format!("could not open cuDNN wheel: {e}"))?;
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("bad cuDNN wheel: {e}"))?;
    std::fs::create_dir_all(dest).map_err(|e| format!("could not create {}: {e}", dest.display()))?;
    let mut count = 0u32;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if !name.to_ascii_lowercase().ends_with(".dll") {
            continue;
        }
        // Flatten: the wheel nests DLLs under nvidia/cudnn/bin/, and the child
        // only needs them on PATH. Anything with a path separator or `..` is
        // skipped outright (zip-slip guard) — a legitimate entry is a bare name.
        let base = name.rsplit('/').next().unwrap_or(&name).to_string();
        if base.contains("..") || base.contains('\\') || base.contains('/') {
            continue;
        }
        let out = dest.join(&base);
        let mut out_file =
            std::fs::File::create(&out).map_err(|e| format!("could not write {base}: {e}"))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("could not extract {base}: {e}"))?;
        count += 1;
    }
    Ok(count)
}

/// Install the GPU runtime (Settings button): the CUDA build of the engine plus
/// the cuDNN runtime it needs. Idempotent — each half is skipped when already
/// present, so a retry after a failed second download does not re-fetch 456 MB.
#[tauri::command]
pub async fn tts_install_gpu(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
) -> CmdResult<TtsGpuStatus> {
    #[cfg(not(windows))]
    {
        let _ = (&app, &db);
        return Err(
            "GPU synthesis is Windows-only for now — the vendor publishes CUDA builds for Windows and Linux, but only the Windows pair is pinned and verified here."
                .into(),
        );
    }

    #[cfg(windows)]
    {
        let root = gpu_root(&app);
        let downloads = root.join("downloads");

        if gpu_exe(&root).is_none() {
            let archive = downloads.join("sherpa-cuda.tar.bz2");
            download_pinned(
                &app,
                GPU_BUNDLE_URL,
                GPU_BUNDLE_SHA256,
                "the CUDA voice engine",
                GPU_BUNDLE_SIZE,
                &archive,
            )
            .await?;
            let bundle_for_task = archive.clone();
            let root_for_task = root.clone();
            tauri::async_runtime::spawn_blocking(move || {
                extract_gpu_bundle(&bundle_for_task, &root_for_task)
            })
            .await
            .map_err(|e| format!("extract task failed: {e}"))??;
            let _ = std::fs::remove_file(&archive);
            if gpu_exe(&root).is_none() {
                let msg = "the CUDA bundle did not contain the voice engine".to_string();
                emit_progress(&app, GPU_INSTALL_ID, DownloadState::Error, 0, None, Some(msg.clone()));
                return Err(msg);
            }
        }

        if !gpu_cudnn_dir(&root).join("cudnn64_9.dll").is_file() {
            let wheel = downloads.join("cudnn-cu13.whl");
            download_pinned(
                &app,
                CUDNN_WHEEL_URL,
                CUDNN_WHEEL_SHA256,
                "the cuDNN runtime",
                CUDNN_WHEEL_SIZE,
                &wheel,
            )
                .await?;
            let wheel_for_task = wheel.clone();
            let dest_for_task = gpu_cudnn_dir(&root);
            let count = tauri::async_runtime::spawn_blocking(move || {
                extract_cudnn_dlls(&wheel_for_task, &dest_for_task)
            })
            .await
            .map_err(|e| format!("cudnn extract task failed: {e}"))??;
            eprintln!("[tts] extracted {count} cuDNN DLLs");
            let _ = std::fs::remove_file(&wheel);
        }

        let _ = std::fs::remove_dir(&downloads);
        {
            let conn = db.0.lock();
            db::set_setting(&conn, GPU_DIR_KEY, &root.to_string_lossy())
                .map_err(|e| e.to_string())?;
        }
        emit_progress(&app, GPU_INSTALL_ID, DownloadState::Done, 0, None, None);
        Ok(gpu_status_of(&root))
    }
}

#[tauri::command]
pub async fn tts_gpu_status(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
) -> CmdResult<TtsGpuStatus> {
    let root = {
        let conn = db.0.lock();
        db::get_setting(&conn, GPU_DIR_KEY)
            .ok()
            .flatten()
            .map(PathBuf::from)
            .unwrap_or_else(|| gpu_root(&app))
    };
    let _ = &*db;
    Ok(gpu_status_of(&root))
}

/// Synthesize one chunk with the CUDA build. Spawns a child, so it is expensive
/// per call — see the module header.
pub async fn synthesize_gpu(
    root: &Path,
    model_dir: &Path,
    text: &str,
    sid: i32,
    speed: f32,
) -> CmdResult<Vec<u8>> {
    let exe = gpu_exe(root).ok_or(
        "the GPU engine is not installed — click Install GPU support in Settings → Local Models → Speech",
    )?;
    let paths = kokoro_paths(model_dir)?;
    let out = std::env::temp_dir().join(format!("relay-tts-{}.wav", uuid::Uuid::new_v4()));

    let mut args: Vec<String> = vec![
        format!("--kokoro-model={}", paths.model.display()),
        format!("--kokoro-voices={}", paths.voices.display()),
        format!("--kokoro-tokens={}", paths.tokens.display()),
    ];
    if let Some(dir) = &paths.data_dir {
        args.push(format!("--kokoro-data-dir={}", dir.display()));
    }
    if let Some(lexicon) = paths.lexicons_arg() {
        args.push(format!("--kokoro-lexicon={lexicon}"));
    }
    args.push(format!("--sid={sid}"));
    args.push(format!("--speed={speed}"));
    args.push("--provider=cuda".to_string());
    args.push(format!("--num-threads={}", tts_threads()));
    args.push(format!("--output-filename={}", out.display()));
    args.push(text.to_string());

    // The CUDA build links against CUDA and cuDNN but ships neither, so both
    // directories go on the child's PATH. The bundle's own `bin` comes along
    // too — that is where onnxruntime_providers_cuda.dll lives, next to the exe.
    let mut search: Vec<String> = vec![
        gpu_cudnn_dir(root).to_string_lossy().into_owned(),
        gpu_bin_dir(root).to_string_lossy().into_owned(),
    ];
    if let Some(cuda) = detect_cuda_runtime() {
        search.push(cuda.to_string_lossy().into_owned());
    }
    if let Some(existing) = std::env::var_os("PATH") {
        search.push(existing.to_string_lossy().into_owned());
    }

    let mut cmd = tokio::process::Command::new(&exe);
    cmd.args(&args)
        .env("PATH", search.join(";"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let t0 = std::time::Instant::now();
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("could not start the GPU engine: {e}"))?;
    if !output.status.success() {
        // The interesting part of a CUDA failure is at the end of stderr (the
        // provider's own error), so keep the tail rather than the header.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr
            .lines()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .join(" | ");
        let _ = std::fs::remove_file(&out);
        return Err(format!(
            "the GPU engine failed ({}). This usually means the CUDA or cuDNN runtime is missing or mismatched. Details: {tail}",
            output.status
        ));
    }
    let bytes = std::fs::read(&out)
        .map_err(|e| format!("the GPU engine reported success but wrote no audio: {e}"))?;
    let _ = std::fs::remove_file(&out);
    eprintln!(
        "[tts] gpu synthesized {} chars -> {} KB in {} ms",
        text.chars().count(),
        bytes.len() / 1024,
        t0.elapsed().as_millis()
    );
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_resume_decision_rejects_impossible_ranges() {
        // Nothing on disk yet: a plain GET, no Range header.
        assert!(!partial_is_resumable(0, 419_603_885));
        // A genuine partial: resumable.
        assert!(partial_is_resumable(1_000, 419_603_885));
        assert!(partial_is_resumable(419_603_884, 419_603_885));
        // Exactly the full size — asking for bytes=<size>- is a 416, and the
        // file is either complete or the append doubled it. Refetch.
        assert!(!partial_is_resumable(419_603_885, 419_603_885));
        // Past the expected size: a doubled/corrupt partial. Refetch.
        assert!(!partial_is_resumable(839_207_770, 419_603_885));
        // Unknown expected size: any non-empty partial is worth a try.
        assert!(partial_is_resumable(1_000, 0));
        assert!(!partial_is_resumable(0, 0));
    }

    #[test]
    fn completion_length_check_catches_short_bodies() {
        assert!(length_is_expected(419_603_885, 419_603_885));
        // A clean early close looks like success to the pump; only the length
        // gives it away.
        assert!(!length_is_expected(12_000, 419_603_885));
        assert!(!length_is_expected(419_603_886, 419_603_885));
        // Unknown expected size: nothing to compare against, accept.
        assert!(length_is_expected(12_000, 0));
    }

    /// End-to-end exercise of the resume path against a live server, using a
    /// small real artifact (the model's `tokens.txt`, 687 bytes) so the whole
    /// flow runs for real: range request, Content-Range confirmation, append,
    /// length check, SHA-256 verification.
    ///
    ///   cargo test --lib resume_path -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn resume_path_completes_and_recovers_from_a_corrupt_partial() {
        const URL: &str =
            "https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_0/resolve/main/tokens.txt";
        // sha256 of the real file. Note: hashing `curl` output WITHOUT -L hashes the
        // 307 redirect stub instead, which is a wrong-but-plausible constant.
        const SHA: &str = "6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425";
        const SIZE: u64 = 687;
        let app = tauri::test::mock_app().handle().clone();
        let client = http_client().expect("client");

        // 1. A genuine partial is resumed and completed.
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("tokens.txt");
        let part = dest.with_extension("part");
        let head = client
            .get(URL)
            .header(reqwest::header::RANGE, "bytes=0-99")
            .send()
            .await
            .expect("range fetch")
            .bytes()
            .await
            .expect("body");
        assert_eq!(head.len(), 100, "server must honour the range");
        std::fs::write(&part, &head).expect("seed partial");
        download_pinned(&app, URL, SHA, "test artifact", SIZE, &dest)
            .await
            .expect("resume completes");
        assert_eq!(std::fs::read(&dest).expect("read").len(), SIZE as usize);
        assert!(!part.exists(), "the partial is consumed by the rename");

        // 2. A partial at/past the expected size is discarded rather than being
        //    resumed with an impossible range — the "416 Range Not Satisfiable"
        //    that broke a real GPU install.
        let dir2 = tempfile::tempdir().expect("tempdir");
        let dest2 = dir2.path().join("tokens.txt");
        let part2 = dest2.with_extension("part");
        std::fs::write(&part2, vec![0u8; (SIZE as usize) * 2]).expect("seed oversized partial");
        download_pinned(&app, URL, SHA, "test artifact", SIZE, &dest2)
            .await
            .expect("oversized partial recovers");
        assert_eq!(std::fs::read(&dest2).expect("read").len(), SIZE as usize);
    }

    /// Reaches the two hosts the GPU install depends on, through the exact
    /// client the installer uses. This is the regression that mattered: the
    /// cuDNN download failed at the request stage on a real machine, so the
    /// thing worth asserting is "this client can talk to these hosts at all".
    ///
    ///   cargo test --lib cudnn_host -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn can_reach_the_gpu_download_hosts() {
        println!("system proxy: {:?}", super::super::tts::system_proxy_for_log());
        let client = http_client().expect("client");
        for (label, url) in [
            ("cuDNN (files.pythonhosted.org)", CUDNN_WHEEL_URL),
            ("CUDA engine (github.com)", GPU_BUNDLE_URL),
        ] {
            let resp = client
                .get(url)
                .header(reqwest::header::RANGE, "bytes=0-1023")
                .send()
                .await
                .unwrap_or_else(|e| panic!("{label}: request failed: {e}"));
            let status = resp.status();
            assert!(
                status.is_success(),
                "{label}: unexpected status {status}"
            );
            let bytes = resp.bytes().await.expect("body");
            println!("{label}: HTTP {status}, {} bytes", bytes.len());
            assert!(!bytes.is_empty(), "{label}: empty body");
            // Range support is what makes a retry resume instead of restart,
            // which is the difference between losing 10% and losing 420 MB.
            assert_eq!(status, reqwest::StatusCode::PARTIAL_CONTENT, "{label}: no range support");
        }
    }
}
