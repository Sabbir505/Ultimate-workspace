//! Update checks for the pinned NATIVE builds — the harness-updater shape
//! (installed version vs the pinned latest, one row per artifact) applied to
//! the binaries this app downloads and executes: the whisper.cpp server (CPU
//! build), the whisper.cpp CUDA build, the llama.cpp CUDA server, and the
//! sherpa-onnx CUDA TTS runtime.
//!
//! Versioning: each installer stamps a `build-version.json` marker into its
//! install dir; a check compares that marker against the version this app
//! pins — the same constants the installers download. A build on disk with
//! no marker reads as "installed, unknown vintage": the update is offered,
//! since the pinned build is the one this app has verified.
//!
//! The llama-server row has one extra wrinkle: CUDA builds the user dropped
//! themselves (drive-scan / path setting) are legitimately in use without
//! any marker. For those the check probes the ACTIVE binary (`--version`,
//! CUDA-capability) and offers the managed prebuilt with a note saying
//! exactly what updating does — the custom build is never modified.

use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;

use tauri::State;

use crate::DbState;

/// One updatable native build. Mirrors the harness row's shape
/// (`HarnessUpdateStatus`) so the Settings UI can treat them alike.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildUpdateStatus {
    /// Stable id the frontend keys on: "stt-whisper", "stt-whisper-cuda",
    /// "llama-cuda", "tts-gpu".
    pub id: String,
    pub title: String,
    /// The build's primary artifact is on disk (marker or not).
    pub installed: bool,
    /// Version stamped by the installer, when known.
    pub installed_version: Option<String>,
    /// The pin this app carries — what an update installs.
    pub latest_version: String,
    pub update_available: bool,
    /// Row-specific context (e.g. a custom build is in use and what updating
    /// would do). Rendered as the row's subtitle.
    pub note: Option<String>,
}

/// The marker file an installer stamps into its install dir after a verified
/// install. Sits next to the binaries.
const MARKER_FILE: &str = "build-version.json";

pub fn write_build_marker(dir: &Path, version: &str) -> Result<(), String> {
    let json = serde_json::json!({ "version": version }).to_string();
    std::fs::write(dir.join(MARKER_FILE), json)
        .map_err(|e| format!("could not write build version marker: {e}"))
}

pub fn read_build_marker(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(MARKER_FILE)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version")?.as_str().map(String::from)
}

/// Progress ids and install-dir names for the managed builds — shared here
/// so check and install can never drift apart on the dir layout.
pub const WHISPER_CPU_DIR: &str = "whisper-cpp";
/// The whisper CUDA build lives in the dir `stt.rs`'s CUDA_SUBDIR names.
pub const TTS_GPU_DIR: &str = "sherpa-onnx-cuda";

/// Newest llama.cpp build release tag (the `b<number>` tags; non-b releases
/// like app builds sit in the same list). One GET, 8s budget; None offline —
/// callers fall back to the pinned tag.
async fn latest_llama_tag() -> Option<String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("Relay/", env!("CARGO_PKG_VERSION"), " (desktop)"))
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .ok()?;
    let releases: serde_json::Value = client
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    releases
        .as_array()?
        .iter()
        .find_map(|r| {
            let tag = r.get("tag_name")?.as_str()?;
            tag.starts_with('b').then(|| tag.to_string())
        })
}

#[tauri::command]
pub async fn check_build_updates(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
) -> Result<Vec<BuildUpdateStatus>, String> {
    let latest_llama = latest_llama_tag()
        .await
        .unwrap_or_else(|| crate::commands::llama_build::LLAMA_CPP_TAG.to_string());
    // Snapshot the llama-server path setting without parking the guard
    // across the await above/below (parking_lot is !Send).
    let llama_user_path = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, crate::chat::local_models::LLAMA_SERVER_PATH_KEY)
            .ok()
            .flatten()
    };
    let rows = tauri::async_runtime::spawn_blocking(move || {
        let app_data = crate::user_dirs::app_data_dir(&app).join("bin");
        let whisper_cpu_dir = app_data.join(WHISPER_CPU_DIR);
        let whisper_cuda_dir = app_data.join(crate::commands::stt::CUDA_SUBDIR);
        let llama_cuda_dir = crate::commands::llama_build::llama_cuda_dir(&app);
        let tts_dir = app_data.join(TTS_GPU_DIR);
        let tag = crate::commands::stt::WHISPER_RELEASE_TAG;
        vec![
            row(
                "stt-whisper",
                "Whisper server (CPU build)",
                whisper_cpu_dir,
                crate::commands::stt::cpu_build_installed(&app),
                tag,
                None,
            ),
            row(
                "stt-whisper-cuda",
                "Whisper server (CUDA build)",
                whisper_cuda_dir,
                crate::commands::stt::cuda_build_installed(&app),
                tag,
                None,
            ),
            llama_row(llama_cuda_dir, &latest_llama, llama_user_path.as_deref()),
            row(
                "tts-gpu",
                "Voice GPU runtime (sherpa-onnx CUDA)",
                tts_dir,
                crate::commands::tts_gpu::gpu_build_installed(&app),
                crate::commands::tts_gpu::GPU_BUNDLE_VERSION,
                None,
            ),
        ]
    })
    .await
    .map_err(|e| format!("build update check failed: {e}"))?;
    Ok(rows)
}

/// Generic managed-build row: installed per its marker; update offered when
/// the marker is missing or behind this app's pin.
#[allow(clippy::too_many_arguments)]
fn row(
    id: &str,
    title: &str,
    dir: PathBuf,
    installed: bool,
    latest: &str,
    note: Option<String>,
) -> BuildUpdateStatus {
    let installed_version = read_build_marker(&dir);
    BuildUpdateStatus {
        id: id.to_string(),
        title: title.to_string(),
        installed,
        installed_version: installed_version.clone(),
        latest_version: latest.to_string(),
        // On disk but not at this app's pinned version (stamped older, or
        // dropped in manually with no marker at all) — offer the update.
        update_available: installed && installed_version.as_deref() != Some(latest),
        note,
    }
}

/// The llama-server row: the managed build carries a marker like the others,
/// but a CUSTOM CUDA build elsewhere (drive-scan, path setting) can be the
/// one actually in use — probe it so the row reflects reality and says what
/// an update would do.
fn llama_row(dir: PathBuf, latest: &str, user_path: Option<&str>) -> BuildUpdateStatus {
    let marker = read_build_marker(&dir);
    let managed = crate::commands::llama_build::llama_cuda_dir_default()
        .join("llama-server.exe")
        .is_file();
    let probe = if marker.is_none() {
        crate::chat::local_models::llama_server_build_probe(user_path)
    } else {
        None
    };
    let installed = managed || probe.as_ref().is_some_and(|p| p.is_cuda);
    let (installed_version, note) = match (&marker, &probe) {
        (Some(v), _) => (Some(v.clone()), None),
        (None, Some(p)) if p.is_cuda => (
            p.version.clone(),
            Some(format!(
                "Custom build in use — updating installs the official prebuilt and points the app at it. Your build at {} is not touched.",
                p.path
            )),
        ),
        (None, Some(_)) => (
            None,
            Some(
                "The active llama-server is a CPU build — the CUDA build adds GPU offload."
                    .to_string(),
            ),
        ),
        (None, None) => (None, None),
    };
    BuildUpdateStatus {
        id: "llama-cuda".to_string(),
        title: "Llama server (CUDA build)".to_string(),
        installed,
        installed_version,
        latest_version: latest.to_string(),
        // A marker compares against the latest tag; a custom build can't be
        // version-compared, so the update is offered (the note says what it
        // does — nothing is replaced silently).
        update_available: installed && match (&marker, &probe) {
            (Some(v), _) => v.as_str() != latest,
            _ => true,
        },
        note,
    }
}
