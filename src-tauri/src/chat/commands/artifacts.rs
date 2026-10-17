//! `commands::artifacts` — carved verbatim from the former commands.rs
//! monolith (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

// ---- Artifacts (30-day retention) ----

/// All persisted artifacts, most recent first.
///
/// `async` (main-thread hazard): this is invoked by the sidebar/library UI, and
/// a non-async command runs INLINE on the IPC thread — which is the UI thread.
/// Every artifact command takes the single shared `DbState` mutex, so any
/// concurrent long holder (a chat turn's writes, an automation run, a
/// checkpoint) would freeze the window for its whole duration. Off the main
/// thread the same wait is just a late promise.
#[tauri::command]
pub async fn list_artifacts(db: State<'_, DbState>) -> CmdResult<Vec<ArtifactRecord>> {
    let records = {
        let conn = db.0.lock();
        db::list_artifacts(&conn)
    };
    records.map_err(|e| e.to_string())
}

/// Artifacts belonging to one chat session, oldest first, so a reopened chat
/// can restore its inline diagrams / file chips. `async` for the same
/// main-thread reason as [`list_artifacts`].
#[tauri::command]
pub async fn list_chat_artifacts(
    chat_session_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Vec<ArtifactRecord>> {
    let records = {
        let conn = db.0.lock();
        db::list_artifacts_for_chat(&conn, &chat_session_id)
    };
    records.map_err(|e| e.to_string())
}

/// Delete an artifact (DB row + on-disk file). `async` for the same
/// main-thread reason as [`list_artifacts`].
#[tauri::command]
pub async fn delete_artifact(id: String, db: State<'_, DbState>) -> CmdResult<()> {
    let path = {
        let conn = db.0.lock();
        db::delete_artifact(&conn, &id).map_err(|e| e.to_string())?
    };
    if let Some(path) = path {
        // `spawn_blocking` so the unlink never occupies a runtime worker, and
        // best-effort so a vanish-race or permission error cannot fail the row
        // deletion that already landed.
        let _ = tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_file(path);
        })
        .await;
    }
    Ok(())
}

/// Delete every artifact: each DB row + its on-disk file (best-effort), then
/// sweep any leftover files inside the resolved artifacts dir that have no
/// row. Never touches anything outside the resolved artifacts dir. Returns
/// the number of files removed.
///
/// PERF (PERFORMANCE_AUDIT.md B4): the walkdir sweep + per-file deletes run
/// in `spawn_blocking` — for a large artifacts dir the inline version held
/// the IPC worker for 10–30 s.
#[tauri::command]
pub async fn delete_all_artifacts(app: AppHandle, db: State<'_, DbState>) -> CmdResult<usize> {
    let paths = {
        let conn = db.0.lock();
        let artifacts = db::list_artifacts(&conn).map_err(|e| e.to_string())?;
        let mut paths = Vec::with_capacity(artifacts.len());
        for a in &artifacts {
            if let Some(p) = db::delete_artifact(&conn, &a.id).map_err(|e| e.to_string())? {
                paths.push(p);
            }
        }
        paths
    };
    let dir = crate::chat::dispatch::artifacts_dir(&app);
    tokio::task::spawn_blocking(move || {
        let mut removed = 0usize;
        for p in &paths {
            if std::fs::remove_file(p).is_ok() {
                removed += 1;
            }
        }
        // Sweep leftover files (no DB row) — strictly inside the resolved
        // artifacts dir (the walk never escapes it). `_backups` holds the
        // 30-day-expiry recovery zips and is deliberately preserved: clearing
        // the gallery must not destroy the safety net.
        if let Ok(canon_dir) = dir.canonicalize() {
            for entry in walkdir::WalkDir::new(&canon_dir)
                .min_depth(1)
                .into_iter()
                .filter_entry(|e| e.file_name() != std::ffi::OsStr::new("_backups"))
                .filter_map(|e| e.ok())
            {
                if entry.file_type().is_file() && std::fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
        removed
    })
    .await
    .map_err(|e| e.to_string())
}

/// Back up the artifact files about to expire into
/// `<artifacts_dir>/_backups/expired-<date>.zip` so the sweep never silently
/// destroys something the user later wants to check. Best-effort: files that
/// no longer exist (or the zip write itself) are skipped rather than aborting
/// the sweep. Multiple sweeps on the same day get a numeric suffix instead of
/// overwriting the earlier backup. Returns the zip path when at least one file
/// was archived.
fn backup_expired_artifacts(
    artifacts_dir: &std::path::Path,
    paths: &[String],
) -> Option<std::path::PathBuf> {
    use std::io::Write;
    use std::path::Path;
    use zip::write::SimpleFileOptions;

    // Read the doomed files first; a missing/unreadable one is simply not
    // backed up (same silent-skip contract as `download_artifacts_zip`).
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for p in paths {
        if let Ok(bytes) = std::fs::read(p) {
            let name = Path::new(p)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            files.push((name, bytes));
        }
    }
    if files.is_empty() {
        return None;
    }

    let backup_dir = artifacts_dir.join("_backups");
    std::fs::create_dir_all(&backup_dir).ok()?;

    let stamp = chrono::Local::now().format("%Y-%m-%d");
    let mut dest = backup_dir.join(format!("expired-{stamp}.zip"));
    let mut n = 1;
    while dest.exists() {
        dest = backup_dir.join(format!("expired-{stamp}_{n}.zip"));
        n += 1;
    }

    let file = std::fs::File::create(&dest).ok()?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (base, data) in &files {
        let mut name = base.clone();
        let mut dup = 1;
        while used.contains(&name) {
            let (stem, ext) = match base.rsplit_once('.') {
                Some((s, e)) => (s.to_string(), format!(".{e}")),
                None => (base.clone(), String::new()),
            };
            name = format!("{stem} ({dup}){ext}");
            dup += 1;
        }
        used.insert(name.clone());
        if zip.start_file(name, opts).is_err() {
            continue;
        }
        if zip.write_all(data).is_err() {
            continue;
        }
    }
    zip.finish().ok()?;
    Some(dest)
}

/// Sweep artifacts past their 30-day expiry, removing both rows and files.
/// Also purges rows for transient scratch files (lock files, tmp
/// intermediates) that the temp filter now blocks from being recorded —
/// rows written before the filter existed age out of the gallery on the
/// next startup instead of lingering for the retention window. Only ROWS
/// are removed for temp entries: their files live in the user's project
/// dirs. Called on startup (and Settings → Data); returns the number of
/// artifacts removed.
///
/// Expired files are archived to `_backups/` inside `artifacts_dir` BEFORE the
/// unlink (see [`backup_expired_artifacts`]), so the user can still recover
/// something a later check needs. The caller resolves `artifacts_dir` (it must
/// NOT re-lock `DbState` here — see `dispatch::artifacts_dir`).
pub fn sweep_expired_artifacts(
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    artifacts_dir: &std::path::Path,
) -> usize {
    let (paths, temp_removed) = {
        let conn = db.lock();
        let paths = db::delete_expired_artifacts(&conn).unwrap_or_default();
        let temp_removed = db::delete_temp_like_artifacts(
            &conn,
            crate::chat::stream_events::is_temp_like_artifact,
        )
        .unwrap_or(0);
        (paths, temp_removed)
    };
    let n = paths.len() + temp_removed;
    if !paths.is_empty() {
        match backup_expired_artifacts(artifacts_dir, &paths) {
            Some(zip) => crate::relay_eprintln!(
                "[artifacts] backed up {} expired artifact(s) to {}",
                paths.len(),
                zip.display()
            ),
            None => crate::relay_eprintln!(
                "[artifacts] no expired artifact backup written for {} path(s) \
                 (missing/unreadable files or write failure)",
                paths.len()
            ),
        }
    }
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
    n
}

// ---- Artifact download ----

/// Copy a generated artifact to a user-chosen destination path (the frontend
/// gets `dest` from a save dialog). `src` may be any readable path — the
/// preview-scope containment (and with it this command's refusal) was lifted
/// on product decision: these endpoints exist to open the user's files.
#[tauri::command]
pub async fn download_artifact(src: String, dest: String) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || {
        std::fs::copy(&src, &dest).map_err(|e| format!("could not save file: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Zip several artifacts into a user-chosen destination `.zip` path. Duplicate
/// filenames are disambiguated with a numeric suffix. Unreadable paths are
/// skipped — same silent-skip behavior as missing files.
///
/// PERF (PERFORMANCE_AUDIT.md B3): the per-file reads + deflate run in
/// `spawn_blocking` — the sync version blocked the IPC worker for every byte
/// read and compressed.
#[tauri::command]
pub async fn download_artifacts_zip(paths: Vec<String>, dest: String) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        use std::path::Path;
        use zip::write::SimpleFileOptions;

        let file =
            std::fs::File::create(&dest).map_err(|e| format!("could not create zip: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
        for src in &paths {
            let data = match std::fs::read(src) {
                Ok(d) => d,
                Err(_) => continue, // skip missing files rather than aborting the whole zip
            };
            let base = Path::new(src)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            let mut name = base.clone();
            let mut n = 1;
            while used.contains(&name) {
                let (stem, ext) = match base.rsplit_once('.') {
                    Some((s, e)) => (s.to_string(), format!(".{e}")),
                    None => (base.clone(), String::new()),
                };
                name = format!("{stem} ({n}){ext}");
                n += 1;
            }
            used.insert(name.clone());
            zip.start_file(name, opts)
                .map_err(|e| format!("zip error: {e}"))?;
            zip.write_all(&data)
                .map_err(|e| format!("zip error: {e}"))?;
        }
        zip.finish().map_err(|e| format!("zip error: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("relay-artifacts-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn expired_files_are_zipped_into_backups() {
        let dir = tmp_dir("backup");
        let a = dir.join("report.docx");
        let b = dir.join("diagram.svg");
        std::fs::write(&a, b"doc").unwrap();
        std::fs::write(&b, b"<svg/>").unwrap();

        let zip = backup_expired_artifacts(
            &dir,
            &[a.to_string_lossy().to_string(), b.to_string_lossy().to_string()],
        )
        .expect("a backup zip should be written");

        // Lives under <artifacts>/_backups/ and holds both files.
        assert_eq!(zip.parent().and_then(|p| p.file_name()), Some(std::ffi::OsStr::new("_backups")));
        let mut archive =
            zip::ZipArchive::new(std::fs::File::open(&zip).unwrap()).unwrap();
        let mut names: Vec<String> =
            (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["diagram.svg".to_string(), "report.docx".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_skips_missing_files_and_reports_none() {
        let dir = tmp_dir("backup-missing");
        // A row whose file already vanished must not produce an empty zip.
        assert!(backup_expired_artifacts(&dir, &[dir.join("gone.pdf").to_string_lossy().to_string()])
            .is_none());
        assert!(!dir.join("_backups").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

