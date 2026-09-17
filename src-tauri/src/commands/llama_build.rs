//! One-click install/update for the CUDA build of llama.cpp's llama-server —
//! the binary behind Settings → Local Models → My Models ("GGUF via
//! llama-server"). The app bundles a CPU-only llama-server sidecar; GPU
//! offload needs a CUDA build, which until now was a manual drop discovered
//! by drive-scan or pointed at via a path setting / `LLAMA_SERVER_PATH`.
//! This installs the pinned OFFICIAL prebuilt into the app's managed bin dir
//! and points the path setting at it — the same check → Update flow the
//! harness CLIs and the other native builds have. A self-built CUDA drop
//! elsewhere on disk is never touched: updating switches the app to the
//! managed prebuilt, the custom build stays where it is.

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::commands::local_model_market::DownloadState;
use crate::db;
use crate::DbState;

/// Pinned llama.cpp release: the CUDA 12.4 Windows x64 prebuilt. The pin is
/// a compatibility contract with the asset (SHA below); bump deliberately,
/// together with URL + SHA, and the build updater offers the new version —
/// the pin is ALSO the version the updater compares installs against, so a
/// live "newer upstream exists" never nags a build the app can't install.
pub const LLAMA_CPP_TAG: &str = "b10985";
#[cfg(windows)]
const LLAMA_CUDA_ZIP_URL: &str =
    "https://github.com/ggml-org/llama.cpp/releases/download/b10985/llama-b10985-bin-win-cuda-12.4-x64.zip";
/// SECURITY: this download is executed, so TLS alone is not enough — SHA-256
/// verified against the asset at pin time, before anything is extracted.
#[cfg(windows)]
const LLAMA_CUDA_ZIP_SHA256: &str =
    "fef8923757bddcbe1785646f63909a13ce28a4c065ed5661c1cd57579975c4d4";
/// Archive size (bytes) — the progress denominator before headers arrive.
pub const LLAMA_CUDA_ZIP_SIZE: u64 = 254_196_265;

/// Managed install dir (sibling of the whisper builds) + progress id.
pub const LLAMA_CUDA_DIR: &str = "llama-cpp-cuda";
pub const LLAMA_CUDA_INSTALL_ID: &str = "llama-cuda-server";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlamaCudaInstallStatus {
    pub installed: bool,
    pub exe_path: Option<String>,
    pub version: Option<String>,
}

/// The managed CUDA build's install dir (needs an `AppHandle`).
pub fn llama_cuda_dir(app: &tauri::AppHandle) -> PathBuf {
    crate::user_dirs::app_data_dir(app).join("bin").join(LLAMA_CUDA_DIR)
}

/// Same, without an `AppHandle` (resolution path in `local_models.rs`).
pub fn llama_cuda_dir_default() -> PathBuf {
    crate::user_dirs::app_data_dir_default().join("bin").join(LLAMA_CUDA_DIR)
}

fn llama_cuda_exe(dir: &PathBuf) -> PathBuf {
    let exe = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    dir.join(exe)
}

/// The managed CUDA build's llama-server is on disk.
pub fn llama_cuda_build_installed(app: &tauri::AppHandle) -> bool {
    llama_cuda_exe(&llama_cuda_dir(app)).is_file()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLlamaServer {
    pub path: String,
    pub version: Option<String>,
    pub is_cuda: bool,
}

/// One-click install (or, with `force`, update) of the pinned official CUDA
/// prebuilt. Progress arrives under id "llama-cuda-server" on the shared
/// download stream. On success the app's llama-server path setting points at
/// the managed build, so it wins resolution without touching any custom
/// build elsewhere on disk.
#[tauri::command]
pub async fn llama_install_cuda(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    local: State<'_, crate::chat::local_models::LocalModelState>,
    force: Option<bool>,
) -> CmdResult<LlamaCudaInstallStatus> {
    #[cfg(not(windows))]
    {
        let _ = (&app, &db, &local, &force);
        return Err(
            "the CUDA llama-server one-click install is Windows-only right now — place a CUDA \
             llama-server build in the app's bin/llama-cpp-cuda folder instead"
                .into(),
        );
    }

    #[cfg(windows)]
    {
        let force = force == Some(true);
        let install_dir = llama_cuda_dir(&app);
        let exe_path = llama_cuda_exe(&install_dir);
        let fresh = force || !exe_path.is_file();
        if fresh {
            // A running llama-server holds its image (and its DLLs) open —
            // stop the sidecars before the files underneath them are
            // replaced (updates only; a first install has nothing running
            // from the managed dir).
            if force {
                local.0.stop_all().await;
            }
            crate::commands::pinned_zip::install_pinned_zip(
                &app,
                LLAMA_CUDA_ZIP_URL,
                LLAMA_CUDA_ZIP_SHA256,
                LLAMA_CPP_TAG,
                &install_dir,
                LLAMA_CUDA_INSTALL_ID,
            )
            .await?;
            crate::commands::pinned_zip::require_entry(
                &install_dir,
                "llama-server.exe",
                LLAMA_CUDA_INSTALL_ID,
                &app,
            )?;
            crate::commands::build_updates::write_build_marker(&install_dir, LLAMA_CPP_TAG)?;
        }

        // Point the app's llama-server path at the managed build — top of the
        // resolution chain after an explicit user override. Written directly
        // (no exec-gate dialog): this is an app-initiated, user-clicked
        // install of a SHA-verified build, the same contract as the whisper
        // installers writing `stt.whisperServerPath`.
        {
            let conn = db.0.lock();
            db::set_setting(
                &conn,
                crate::chat::local_models::LLAMA_SERVER_PATH_KEY,
                &exe_path.to_string_lossy(),
            )
            .map_err(|e| e.to_string())?;
        }
        crate::commands::pinned_zip::emit_progress_for(
            &app,
            LLAMA_CUDA_INSTALL_ID,
            DownloadState::Done,
            0,
            None,
            Some(exe_path.to_string_lossy().into_owned()),
            None,
        );
        Ok(LlamaCudaInstallStatus {
            installed: exe_path.is_file(),
            exe_path: Some(exe_path.to_string_lossy().into_owned()),
            version: Some(LLAMA_CPP_TAG.to_string()),
        })
    }
}

type CmdResult<T> = Result<T, String>;
