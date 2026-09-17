//! Shared pinned-release installer for the native builds (whisper CPU/CUDA,
//! llama.cpp CUDA): stream the zip to a temp file with throttled progress,
//! verify the SHA-256 BEFORE extracting anything, then flatten the exe/dll
//! entries into the install dir (release zips nest binaries under `Release/`
//! or ship them flat — flattening covers both, and every consumer here
//! executes what it extracts, so the verify-before-extract contract lives in
//! exactly one place).

use std::path::{Path, PathBuf};

use crate::commands::local_model_market::DownloadState;

/// Streaming SHA-256 of a file, lowercase hex. Chunked (1 MiB) so a large
/// zip never lands wholly in memory. Sync — call from `spawn_blocking`.
pub fn sha256_file_hex(path: &Path) -> Result<String, String> {
    use sha2::Digest;
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("could not open downloaded zip: {e}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("could not read downloaded zip: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Emit progress on the shared model-download event stream under a
/// build-specific id (the settings panels render these bars per id).
pub fn emit_progress_for(
    app: &tauri::AppHandle,
    id: &str,
    state: DownloadState,
    downloaded: u64,
    total: Option<u64>,
    final_path: Option<String>,
    error: Option<String>,
) {
    let _ = app.emit(
        "local-model:download:progress",
        crate::commands::local_model_market::DownloadProgress {
            id: id.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            state,
            bytes_per_second: 0.0,
            final_path,
            error,
        },
    );
}

use tauri::Emitter;

/// Download `url`, SHA-verify against `sha256`, and extract the exe/dll
/// entries flat into `install_dir`. `progress_id` scopes the progress events.
/// Callers confirm their expected binary landed (see [`require_entry`]) and
/// stamp the version marker.
pub async fn install_pinned_zip(
    app: &tauri::AppHandle,
    url: &str,
    sha256: &str,
    version: &str,
    install_dir: &Path,
    progress_id: &str,
) -> Result<(), String> {
    use futures_util::StreamExt;

    std::fs::create_dir_all(install_dir)
        .map_err(|e| format!("could not create install dir: {e}"))?;
    emit_progress_for(app, progress_id, DownloadState::Starting, 0, None, None, None);

    // Stream to a temp file next to the destination with throttled progress
    // events (same 150ms cadence as the model downloader). NOT `.no_proxy()`:
    // this fetches from github.com, and bypassing the system proxy makes the
    // download fail outright on proxied networks (verified against a local
    // 127.0.0.1 proxy setup). The no-proxy rule is right for talking to our
    // own loopback sidecar, wrong for reaching the internet.
    let client = reqwest::Client::builder()
        .user_agent(concat!("Relay/", env!("CARGO_PKG_VERSION"), " (desktop)"))
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .header("User-Agent", "relay-native-install")
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        let msg = format!("download failed: HTTP {} from {url}", resp.status());
        emit_progress_for(app, progress_id, DownloadState::Error, 0, None, None, Some(msg.clone()));
        return Err(msg);
    }
    let total = resp.content_length();
    let zip_path = std::env::temp_dir().join(format!("relay-{progress_id}-{version}.zip"));
    let mut file = tokio::fs::File::create(&zip_path)
        .await
        .map_err(|e| format!("could not write temp file: {e}"))?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let msg = format!("download failed mid-stream: {e}");
            emit_progress_for(app, progress_id, DownloadState::Error, downloaded, total, None, Some(msg.clone()));
            // The partial temp zip must not survive a failed install.
            let _ = std::fs::remove_file(&zip_path);
            msg
        })?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("could not write temp file: {e}"))?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed().as_millis() >= 150 {
            last_emit = std::time::Instant::now();
            emit_progress_for(app, progress_id, DownloadState::Downloading, downloaded, total, None, None);
        }
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| format!("could not flush temp file: {e}"))?;
    drop(file);

    // SECURITY: verify the pinned SHA-256 BEFORE extracting or executing
    // anything from the zip (TLS alone would let a compromised CDN install
    // arbitrary binaries).
    emit_progress_for(app, progress_id, DownloadState::Verifying, downloaded, total, None, None);
    let verify_zip = zip_path.clone();
    let actual = tauri::async_runtime::spawn_blocking(move || sha256_file_hex(&verify_zip))
        .await
        .map_err(|e| format!("verify task failed: {e}"))??;
    if actual != sha256 {
        // Remove the bad download — the temp file must never survive a
        // failed install (it used to be cleaned only on success).
        let _ = std::fs::remove_file(&zip_path);
        let msg = format!(
            "downloaded release failed SHA-256 verification \
             (expected {sha256}, got {actual}). Not installing — \
             check your network/proxy or retry; if it persists the upstream \
             asset changed and Relay needs an update."
        );
        emit_progress_for(app, progress_id, DownloadState::Error, downloaded, total, None, Some(msg.clone()));
        return Err(msg);
    }

    let extract_dir = install_dir.to_path_buf();
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
            // Case-insensitive: an entry named e.g. FOO.DLL must not be
            // silently skipped by a lowercase-only match.
            let name_lower = name.to_lowercase();
            if !(name_lower.ends_with(".exe") || name_lower.ends_with(".dll")) {
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
    eprintln!("[builds] extracted {extracted} files into {}", install_dir.display());
    let _ = std::fs::remove_file(&zip_path);
    Ok(())
}

/// Confirm a fresh install actually delivered the binary it promised (a
/// release that repointed its assets could otherwise "succeed" with only
/// DLLs on disk).
pub fn require_entry(
    install_dir: &Path,
    exe_name: &str,
    progress_id: &str,
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    let exe_path = install_dir.join(exe_name);
    if !exe_path.is_file() {
        let msg = format!("downloaded release did not contain {exe_name}");
        emit_progress_for(app, progress_id, DownloadState::Error, 0, None, None, Some(msg.clone()));
        return Err(msg);
    }
    Ok(exe_path)
}
