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
        // artifacts dir (the walk never escapes it).
        if let Ok(canon_dir) = dir.canonicalize() {
            for entry in walkdir::WalkDir::new(&canon_dir)
                .min_depth(1)
                .into_iter()
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

/// Sweep artifacts past their 30-day expiry, removing both rows and files.
/// Called on startup; returns the number of artifacts removed.
pub fn sweep_expired_artifacts(db: &Arc<parking_lot::Mutex<rusqlite::Connection>>) -> usize {
    let paths = {
        let conn = db.lock();
        db::delete_expired_artifacts(&conn).unwrap_or_default()
    };
    let n = paths.len();
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
    n
}

// ---- Artifact download ----

/// Copy a generated artifact to a user-chosen destination path (the frontend
/// gets `dest` from a save dialog). `src` must sit inside the preview scope —
/// see [`preview_scope_roots`]; `dest` is user-chosen and unrestricted.
#[tauri::command]
pub async fn download_artifact(
    app: AppHandle,
    db: State<'_, DbState>,
    src: String,
    dest: String,
) -> CmdResult<()> {
    let roots = preview_scope_roots_blocking(&db, &app).await?;
    if path_in_preview_scope(&src, &roots).is_none() {
        return Err(format!(
            "Refusing to save \"{src}\": it is outside the folders Relay can \
             access (your projects, chat worktrees, the artifacts folder, and \
             user-granted roots)."
        ));
    }
    tokio::task::spawn_blocking(move || {
        std::fs::copy(&src, &dest).map_err(|e| format!("could not save file: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Zip several artifacts into a user-chosen destination `.zip` path. Duplicate
/// filenames are disambiguated with a numeric suffix. Paths outside the
/// preview scope (see [`preview_scope_roots`]) are skipped — same silent-skip
/// behavior as unreadable files.
///
/// PERF (PERFORMANCE_AUDIT.md B3): the per-file reads + deflate run in
/// `spawn_blocking` — the sync version blocked the IPC worker for every byte
/// read and compressed.
#[tauri::command]
pub async fn download_artifacts_zip(
    app: AppHandle,
    db: State<'_, DbState>,
    paths: Vec<String>,
    dest: String,
) -> CmdResult<()> {
    let roots = preview_scope_roots_blocking(&db, &app).await?;
    let allowed: Vec<String> = paths
        .into_iter()
        .filter(|p| path_in_preview_scope(p, &roots).is_some())
        .collect();
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
        for src in &allowed {
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

