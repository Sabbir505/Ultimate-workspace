//! Sidebar art — a user-uploaded background image for the sidebar's header
//! block (Relay wordmark + search). The picker dialog lives in the frontend;
//! these commands copy the picked file into the app data dir (the original is
//! never moved), hand the webview the bytes as a data URL (no asset-protocol
//! scope needed), and keep the stored location in `sidebar.artPath`.

use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::db;
use crate::user_dirs;
use crate::DbState;

const ART_SETTING: &str = "sidebar.artPath";
const PRESET_SETTING: &str = "sidebar.artPreset";
const FILE_STEM: &str = "sidebar-art";
/// Generous ceiling for a decorative header image — keeps the base64 handed
/// to the webview (and the copy) bounded if someone picks a huge photo.
const MAX_ART_BYTES: u64 = 25 * 1024 * 1024;

/// Stock art ids shipped with the app (public/sideart/<id>.png in the
/// frontend bundle). The backend only validates and stores the id; the bytes
/// load from the frontend's own assets.
const PRESET_IDS: [&str; 6] = ["aurora", "ember", "violet", "waves", "dusk", "forest"];

/// Extensions accepted for the sidebar art, with their data-URL MIME types.
const ALLOWED: [(&str, &str); 7] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
];

fn mime_for(ext: &str) -> Option<&'static str> {
    ALLOWED
        .iter()
        .find(|(e, _)| e.eq_ignore_ascii_case(ext))
        .map(|(_, m)| *m)
}

/// Delete every `sidebar-art.*` variant in the data dir. Returns quietly when
/// none exist — this runs on import (replace) and on clear.
fn remove_stored_files(data_dir: &std::path::Path) {
    for ext in ALLOWED.iter().map(|(e, _)| *e) {
        let _ = std::fs::remove_file(data_dir.join(format!("{FILE_STEM}.{ext}")));
    }
}

/// Import a picked image: validate, copy into the app data dir, remember the
/// path in settings, and return it. The stored file is what later launches
/// load from — the original can be deleted by the user without breaking us.
#[tauri::command(async)]
pub fn import_sidebar_art(
    app: AppHandle,
    db: State<'_, DbState>,
    source_path: String,
) -> Result<String, String> {
    let source = PathBuf::from(&source_path);
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| "the picked file has no extension".to_string())?;
    if mime_for(ext).is_none() {
        return Err(format!(
            "unsupported image type '.{ext}' (use png, jpg, webp, gif, avif or bmp)"
        ));
    }
    let meta = std::fs::metadata(&source)
        .map_err(|e| format!("couldn't read the picked image: {e}"))?;
    if meta.len() > MAX_ART_BYTES {
        return Err("image is over the 25 MB limit — pick a smaller one".into());
    }
    if !meta.is_file() {
        return Err("the picked path is not a file".into());
    }

    let data_dir = user_dirs::app_data_dir(&app);
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    // Exactly one stored variant: remove siblings from a previous import so
    // the data dir never accumulates sidebar-art.{png,jpg,…} litter.
    remove_stored_files(&data_dir);
    let dest = data_dir.join(format!(
        "{FILE_STEM}.{}",
        ext.to_ascii_lowercase()
    ));
    std::fs::copy(&source, &dest).map_err(|e| format!("couldn't copy the image: {e}"))?;
    let stored = dest.to_string_lossy().to_string();

    {
        let conn = db.0.lock();
        db::set_setting(&conn, ART_SETTING, &stored).map_err(|e| e.to_string())?;
        // One active art at a time: a custom upload replaces any preset.
        db::set_setting(&conn, PRESET_SETTING, "").map_err(|e| e.to_string())?;
    }
    Ok(stored)
}

/// Select one of the bundled stock images (frontend asset, id-validated).
/// Choosing a preset retires any custom upload — again, one active art.
#[tauri::command(async)]
pub fn set_sidebar_art_preset(
    app: AppHandle,
    db: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    if !PRESET_IDS.contains(&id.as_str()) {
        return Err(format!("unknown sidebar art preset '{id}'"));
    }
    let data_dir = user_dirs::app_data_dir(&app);
    remove_stored_files(&data_dir);
    {
        let conn = db.0.lock();
        db::set_setting(&conn, PRESET_SETTING, &id).map_err(|e| e.to_string())?;
        db::set_setting(&conn, ART_SETTING, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The stored art as a `data:` URL for CSS backgrounds, or None when unset.
/// Data URL rather than `convertFileSrc`: no asset-protocol scope changes, and
/// it works identically in dev and production.
#[tauri::command(async)]
pub fn read_sidebar_art_data(db: State<'_, DbState>) -> Result<Option<String>, String> {
    let path = {
        let conn = db.0.lock();
        db::get_setting(&conn, ART_SETTING)
            .map_err(|e| e.to_string())?
            .filter(|s| !s.trim().is_empty())
    };
    let Some(path) = path else {
        return Ok(None);
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => {
            // Stored file vanished (manual delete, migrated dir) — treat as
            // unset instead of failing every boot.
            return Ok(None);
        }
    };
    if bytes.len() as u64 > MAX_ART_BYTES {
        return Ok(None);
    }
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let mime = mime_for(ext).unwrap_or("image/png");
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:{mime};base64,{b64}")))
}

/// Remove ALL sidebar art (custom file + setting, and the preset selection).
/// The header falls back to plain.
#[tauri::command(async)]
pub fn clear_sidebar_art(app: AppHandle, db: State<'_, DbState>) -> Result<(), String> {
    let data_dir = user_dirs::app_data_dir(&app);
    remove_stored_files(&data_dir);
    let conn = db.0.lock();
    db::set_setting(&conn, ART_SETTING, "").map_err(|e| e.to_string())?;
    db::set_setting(&conn, PRESET_SETTING, "").map_err(|e| e.to_string())?;
    Ok(())
}

/// The stored path itself — used by tests and diagnostics; the UI reads the
/// data URL instead.
#[tauri::command(async)]
pub fn get_sidebar_art_path(db: State<'_, DbState>) -> Result<Option<String>, String> {
    let conn = db.0.lock();
    Ok(db::get_setting(&conn, ART_SETTING)
        .map_err(|e| e.to_string())?
        .filter(|s| !s.trim().is_empty()))
}
