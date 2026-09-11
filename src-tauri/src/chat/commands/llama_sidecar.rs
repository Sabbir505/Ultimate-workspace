//! `commands::local_models` — carved verbatim from the former commands.rs
//! monolith (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

// ---- Local models (GGUF scan / llama-server sidecar) ----

/// Scan a folder (or default locations) for `.gguf` files, returning their
/// metadata and a memory-sanity indicator.
///
/// Async + spawn_blocking: the recursive walk and per-file GGUF header parses
/// can take seconds on a large Downloads folder, and the agent picker re-scans
/// on every popup open — a sync command would run all of that on the MAIN
/// thread and freeze the window per open (same rationale as
/// `list_harness_models`' spawn_blocking).
#[tauri::command]
pub async fn scan_local_models(
    folder: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<Vec<GgufModel>> {
    let db = DbState(std::sync::Arc::clone(&db.0));
    tauri::async_runtime::spawn_blocking(move || scan_local_models_blocking(folder, &db))
        .await
        .map_err(|e| e.to_string())?
}

pub(super) fn scan_local_models_blocking(folder: Option<String>, db: &DbState) -> CmdResult<Vec<GgufModel>> {
    use crate::chat::local_models::{memory_class, GgufFile};

    // When a specific folder is given, scan just that one. Otherwise scan the
    // default locations AND any user-added folders persisted via Settings
    // (the `localModels.folders` setting) — so both the Settings panel and the
    // Chat dropdown see the same full set of models from a bare scan_local_models().
    let files: Vec<GgufFile> = if let Some(dir) = folder {
        local_models::scan_folder(Path::new(&dir), "user")
    } else {
        let mut files = local_models::scan_default_locations();
        let mut seen: std::collections::HashSet<String> =
            files.iter().map(|f| f.id.clone()).collect();
        // Also scan the Model Market's download dir — both the user-picked
        // override (`local_models.dir`) and its ~/Relay/models default —
        // otherwise market downloads never show up in the local list.
        {
            let conn = db.0.lock();
            if let Ok(Some(dir)) = db::get_setting(&conn, "local_models.dir") {
                if !dir.trim().is_empty() {
                    for file in local_models::scan_folder(Path::new(&dir), "market") {
                        if seen.insert(file.id.clone()) {
                            files.push(file);
                        }
                    }
                }
            }
        }
        if let Some(home) = dirs::home_dir() {
            let mut scan = vec![crate::user_dirs::default_models_dir(&home)];
            let legacy = home.join("Conduit").join("models");
            if legacy.exists() && !scan.contains(&legacy) {
                scan.push(legacy);
            }
            for market_default in scan {
                for file in local_models::scan_folder(&market_default, "market") {
                    if seen.insert(file.id.clone()) {
                        files.push(file);
                    }
                }
            }
        }
        // Load persisted user-added folders and scan each, deduping by file id.
        let stored = {
            let conn = db.0.lock();
            db::get_setting(&conn, "localModels.folders")
        };
        if let Ok(Some(json)) = stored {
            if let Ok(list) = serde_json::from_str::<Vec<String>>(&json) {
                for f in list.into_iter().filter(|s| !s.trim().is_empty()) {
                    for file in local_models::scan_folder(Path::new(&f), "user") {
                        if seen.insert(file.id.clone()) {
                            files.push(file);
                        }
                    }
                }
            }
        }
        files
    };

    // Total system RAM for the memory-class indicator.
    let mut sys = sysinfo::System::new_all();
    sys.refresh_memory();
    let total_ram = sys.total_memory();

    let models: Vec<GgufModel> = files
        .into_iter()
        .map(|f| {
            let mc = memory_class(f.size_bytes, total_ram);
            GgufModel {
                id: f.id,
                path: f.path,
                filename: f.filename,
                size_bytes: f.size_bytes,
                name: f.meta.name,
                architecture: f.meta.architecture,
                param_count_label: f.meta.param_count_label,
                quantization: f.meta.quantization,
                memory_class: mc.as_str().to_string(),
                source: f.source,
                has_vision: f.has_vision,
                mmproj_path: f.mmproj_path,
            }
        })
        .collect();

    Ok(models)
}

/// Start a llama-server sidecar, health-check it, and persist the base_url +
/// model so `send_chat_message` picks it up immediately. `overrides` carries
/// live-edited runtime tweaks; when None the persisted per-model blob is
/// loaded (`localModels.overrides`), so every spawn path shares one source of
/// truth. The last-good GPU-layer count is recorded back into the blob so
/// restarts skip the probe ladder.
#[tauri::command]
pub async fn start_local_model(
    model_id: String,
    path: String,
    mmproj_path: Option<String>,
    overrides: Option<local_models::LlamaOverrides>,
    db: State<'_, DbState>,
    local: State<'_, local_models::LocalModelState>,
) -> CmdResult<StartedModel> {
    let ovr = match overrides {
        Some(o) => o,
        None => {
            let conn = db.0.lock();
            local_models::load_overrides(&conn, &model_id)
        }
    };
    // Pre-read the llama-server path (must not hold the lock across await).
    let user_llama_path = {
        let conn = db.0.lock();
        crate::db::get_setting(&conn, local_models::LLAMA_SERVER_PATH_KEY)
            .ok()
            .flatten()
    };
    let started = local
        .0
        .start(
            model_id,
            &path,
            mmproj_path.as_deref(),
            Some(&ovr),
            user_llama_path,
        )
        .await?;

    // Persist the base_url + model for the send path (chat.local_gguf.*).
    //
    // Deliberately does NOT touch `chat.active_provider`: that setting means
    // "the provider the user configured in Settings" and drives which
    // provider NEW chats are seeded with (get_chat_config → newChat). Letting
    // a sidecar spawn flip it globally made every fresh chat come up as
    // local_gguf with a stale model name — even sessions the user never
    // pointed at a local model. After an app restart the sidecar is gone
    // anyway, so seeding local by default was never useful; the send path
    // re-spawns on demand via the warm-up branch below.
    {
        let conn = db.0.lock();
        db::set_setting(&conn, "chat.local_gguf.base_url", &started.base_url)
            .map_err(|e| e.to_string())?;
        db::set_setting(&conn, "chat.local_gguf.model", &started.model_id)
            .map_err(|e| e.to_string())?;
        local_models::save_last_good_ngl(&conn, &started.model_id, started.n_gpu_layers);
    }

    // The frontend runs `warmup_local_prompt` right after this resolves,
    // passing the working dir only it knows (selected project / custom
    // folder / worktree) and keeping its loading spinner up until the
    // warmup completes — "loaded" then means the first message answers
    // immediately.

    // The frontend expects these exact camelCase fields (mirrors types.rs).
    Ok(StartedModel {
        model_id: started.model_id,
        port: started.port,
        n_ctx: started.n_ctx,
        n_gpu_layers: started.n_gpu_layers,
        base_url: started.base_url,
    })
}

#[tauri::command]
pub async fn stop_local_model(
    model_id: String,
    local: State<'_, local_models::LocalModelState>,
) -> CmdResult<()> {
    local.0.stop(&model_id).await;
    Ok(())
}

#[tauri::command(async)]
pub fn local_model_status(
    local: State<'_, local_models::LocalModelState>,
) -> CmdResult<Option<ActiveLocalModel>> {
    Ok(local.0.status().map(|a| ActiveLocalModel {
        model_id: a.model_id,
        port: a.port,
        n_ctx: a.n_ctx,
        n_gpu_layers: a.n_gpu_layers,
        base_url: a.base_url,
    }))
}

/// Get the user-configured llama-server path (if any). Written by the
/// "One-click path setup" button in the Local Models settings panel.
#[tauri::command(async)]
pub fn get_llama_server_path(db: State<'_, DbState>) -> CmdResult<LlamaServerPathResult> {
    let conn = db.0.lock();
    let path_opt = db::get_setting(&conn, local_models::LLAMA_SERVER_PATH_KEY).unwrap_or(None);
    Ok(LlamaServerPathResult { path: path_opt })
}

/// Result wrapper for llama-server path queries
#[derive(Debug, serde::Serialize)]
pub struct LlamaServerPathResult {
    pub path: Option<String>,
}

/// Set the user-configured llama-server path. Returns success with the
/// new path, or an error if the path is invalid (binary not found).
#[tauri::command]
pub async fn set_llama_server_path(path: String, db: State<'_, DbState>) -> CmdResult<String> {
    // Validate: check if the path is a file or a directory with llama-server inside.
    let p = std::path::Path::new(&path);
    let bin_name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    let valid = if p.is_file() {
        true
    } else if cfg!(windows) && p.with_extension("exe").is_file() {
        // On Windows, try adding .exe extension
        true
    } else if p.is_dir() && p.join(bin_name).is_file() {
        // Directory containing the binary
        true
    } else {
        false
    };
    if !valid {
        return Err(format!(
            "Path '{}' is not a valid llama-server binary or directory containing it. \
             On Windows, try '{}llama-server.exe' or '{}'\\llama.cpp\\build\\bin\\llama-server.exe",
            path.trim_end_matches("/\\"),
            path.trim_end_matches("/\\"),
            path.trim_end_matches("/\\")
        ));
    }

    // Store the path as-is (could be a file or directory).
    let conn = db.0.lock();
    db::set_setting(&conn, local_models::LLAMA_SERVER_PATH_KEY, &path)
        .map_err(|e| e.to_string())?;
    Ok(path)
}

/// Detect and set common llama-server installation paths. Returns the
/// detected path or null if none found. Used by "one-click setup".
///
/// `async` + `spawn_blocking`: the probe below walks every drive letter on
/// Windows (a stat on an absent drive is a device query, not a cheap miss) and
/// ends with a `llama-server --version` subprocess wait — seconds of blocking
/// work that used to run on the IPC (UI) thread.
#[tauri::command]
pub async fn detect_llama_server_path(db: State<'_, DbState>) -> CmdResult<LlamaServerPathResult> {
    // Check if already configured via the UI
    let configured = {
        let conn = db.0.lock();
        db::get_setting(&conn, local_models::LLAMA_SERVER_PATH_KEY).unwrap_or(None)
    };
    if let Some(path) = configured.filter(|p| !p.is_empty()) {
        return Ok(LlamaServerPathResult { path: Some(path) });
    }
    let path = tokio::task::spawn_blocking(detect_llama_server_path_blocking)
        .await
        .map_err(|e| e.to_string())?;
    Ok(LlamaServerPathResult { path })
}

/// The blocking half of [`detect_llama_server_path`] — pure filesystem probing
/// plus one `--version` exec, with no DB access (the caller resolves the
/// configured setting first).
pub(super) fn detect_llama_server_path_blocking() -> Option<String> {
    let bin_name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };

    // 1. Check LLAMA_SERVER_PATH environment variable (highest priority)
    if let Ok(env_path) = std::env::var("LLAMA_SERVER_PATH") {
        let p = std::path::Path::new(&env_path);
        if p.is_file()
            || p.with_extension("exe").is_file()
            || p.is_dir() && p.join(bin_name).is_file()
        {
            return Some(env_path);
        }
    }

    if cfg!(windows) {
        // On Windows, scan all drive letters (A-Z) for the source build.
        // Check both the MSVC multi-config layout and the single-config one,
        // plus common flat-drop layouts like legacy CUDA builds (llama-cuda).
        for drive_letter in b'A'..=b'Z' {
            let drive = drive_letter as char;
            // Source builds (MSVC config)
            for rel in [r"\llama.cpp\build\bin\Release", r"\llama.cpp\build\bin"] {
                let candidate = format!("{drive}:{rel}\\{bin_name}");
                if std::path::Path::new(&candidate).is_file() {
                    return Some(candidate);
                }
            }
            // Legacy CUDA drop / flat layouts
            for folder in ["llama-cuda", "llamacpp", "llama.cpp", "llama"] {
                let candidate = format!("{drive}:\\{folder}\\{bin_name}");
                if std::path::Path::new(&candidate).is_file() {
                    return Some(candidate);
                }
            }
        }
        // Also check common alternative locations
        for alt in [r"C:\Program Files\llama.cpp\bin\llama-server.exe"] {
            if std::path::Path::new(alt).is_file() {
                return Some(alt.to_string());
            }
        }
        // Check if llama-server is on PATH (Windows)
        let output = std::process::Command::new(bin_name)
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output();
        if let Ok(out) = output {
            if out.status.success() {
                return Some(bin_name.to_string());
            }
        }
    } else {
        // Unix: similar check for common locations
        let path_output: Option<()> = if let Ok(path) = std::env::var("PATH") {
            for dir in path.split(':') {
                let candidate = format!("{}/{}", dir, bin_name);
                if std::path::Path::new(&candidate).is_file() {
                    return Some(bin_name.to_string());
                }
            }
            None
        } else {
            None
        };

        for candidate in [
            "/usr/local/bin/llama-server",
            "/opt/llama.cpp/build/bin/llama-server",
            "/usr/bin/llama-server",
            "/opt/homebrew/bin/llama-server",
            "/usr/local/opt/llama.cpp/bin/llama-server",
        ] {
            let p = std::path::Path::new(candidate);
            if p.is_file() {
                return Some(candidate.to_string());
            }
            if p.is_dir() && p.join(bin_name).is_file() {
                return Some(candidate.to_string());
            }
        }
        // If PATH lookup succeeded, return the binary name
        if path_output.is_some() {
            return Some(bin_name.to_string());
        }
    }

    None
}

