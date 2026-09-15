//! Update checks for the pinned NATIVE builds — the harness-updater shape
//! (installed version vs the pinned latest, one row per artifact) applied to
//! the binaries this app downloads and executes: the whisper.cpp server (CPU
//! build), the whisper.cpp CUDA build, and the sherpa-onnx CUDA TTS runtime.
//!
//! Versioning: each installer stamps a `build-version.json` marker into its
//! install dir; a check compares that marker against the version this app
//! pins — the same constants the installers download. A build on disk with
//! no marker reads as "installed, unknown vintage": the update is offered,
//! since the pinned build is the one this app has verified.

use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;

/// One updatable native build. Mirrors the harness row's shape
/// (`HarnessUpdateStatus`) so the Settings UI can treat them alike.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildUpdateStatus {
    /// Stable id the frontend keys on: "stt-whisper", "stt-whisper-cuda",
    /// "tts-gpu".
    pub id: String,
    pub title: String,
    /// The build's primary artifact is on disk (marker or not).
    pub installed: bool,
    /// Version stamped by the installer, when known.
    pub installed_version: Option<String>,
    /// The pin this app carries — what an update installs.
    pub latest_version: String,
    pub update_available: bool,
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

/// Progress ids and install-dir names for the three managed builds — shared
/// here so check and install can never drift apart on the dir layout.
pub const WHISPER_CPU_DIR: &str = "whisper-cpp";
/// The whisper CUDA build lives in the dir `stt.rs`'s CUDA_SUBDIR names.
pub const TTS_GPU_DIR: &str = "sherpa-onnx-cuda";

#[tauri::command]
pub async fn check_build_updates(app: tauri::AppHandle) -> Result<Vec<BuildUpdateStatus>, String> {
    let rows = tauri::async_runtime::spawn_blocking(move || {
        let whisper_cpu_dir = crate::user_dirs::app_data_dir(&app).join("bin").join(WHISPER_CPU_DIR);
        let whisper_cuda_dir = crate::user_dirs::app_data_dir(&app)
            .join("bin")
            .join(crate::commands::stt::CUDA_SUBDIR);
        let tts_dir = crate::user_dirs::app_data_dir(&app).join("bin").join(TTS_GPU_DIR);
        let tag = crate::commands::stt::WHISPER_RELEASE_TAG;
        vec![
            row(
                "stt-whisper",
                "Whisper speech server (CPU)",
                whisper_cpu_dir,
                crate::commands::stt::cpu_build_installed(&app),
                tag,
            ),
            row(
                "stt-whisper-cuda",
                "Whisper speech server (CUDA)",
                whisper_cuda_dir,
                crate::commands::stt::cuda_build_installed(&app),
                tag,
            ),
            row(
                "tts-gpu",
                "Voice GPU runtime (sherpa-onnx CUDA)",
                tts_dir,
                crate::commands::tts_gpu::gpu_build_installed(&app),
                crate::commands::tts_gpu::GPU_BUNDLE_VERSION,
            ),
        ]
    })
    .await
    .map_err(|e| format!("build update check failed: {e}"))?;
    Ok(rows)
}

fn row(id: &str, title: &str, dir: PathBuf, installed: bool, latest: &str) -> BuildUpdateStatus {
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
    }
}
