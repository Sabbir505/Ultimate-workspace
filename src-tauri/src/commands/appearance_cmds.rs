//! User-picked background imagery: the sidebar header art AND the app-wide
//! wallpaper. Both slots share one flow — the native file dialog lives in the
//! backend (the renderer never supplies a path — exec-gate principle), the
//! picked file is copied into the app data dir (the original is never moved),
//! and the webview gets the bytes as a data URL (no asset-protocol scope
//! needed). The stored location lives in a settings key per slot.

use tauri::{AppHandle, State};

use crate::db;
use crate::user_dirs;
use crate::DbState;

/// Generous ceiling for a decorative image — keeps the base64 handed to the
/// webview (and the copy) bounded if someone picks a huge photo.
const MAX_ART_BYTES: u64 = 25 * 1024 * 1024;

/// Stock art ids shipped with the app (public/sideart/<id>.jpg in the
/// frontend bundle), shared by both slots. The backend only validates and
/// stores the id; the bytes load from the frontend's own assets.
const PRESET_IDS: [&str; 6] = ["aurora", "ember", "violet", "waves", "dusk", "forest"];

/// Extensions accepted for either slot, with their data-URL MIME types.
const ALLOWED: [(&str, &str); 7] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
];

/// One decorative-image slot: its two settings keys (stored file path,
/// selected preset id) and the file stem its copy uses in the app data dir.
struct ArtSlot {
    path_setting: &'static str,
    preset_setting: &'static str,
    file_stem: &'static str,
}

const SIDEBAR_ART: ArtSlot = ArtSlot {
    path_setting: "sidebar.artPath",
    preset_setting: "sidebar.artPreset",
    file_stem: "sidebar-art",
};

const APP_WALLPAPER: ArtSlot = ArtSlot {
    path_setting: "app.wallpaperPath",
    preset_setting: "app.wallpaperPreset",
    file_stem: "app-wallpaper",
};

fn mime_for(ext: &str) -> Option<&'static str> {
    ALLOWED
        .iter()
        .find(|(e, _)| e.eq_ignore_ascii_case(ext))
        .map(|(_, m)| *m)
}

/// Delete every `<stem>.*` variant in the data dir. Returns quietly when
/// none exist — this runs on import (replace) and on clear.
fn remove_stored_files(data_dir: &std::path::Path, stem: &str) {
    for ext in ALLOWED.iter().map(|(e, _)| *e) {
        let _ = std::fs::remove_file(data_dir.join(format!("{stem}.{ext}")));
    }
}

/// Import a picked image: NATIVE file dialog first (exec-gate principle —
/// the renderer used to pass an arbitrary path here, which made this an
/// image-only arbitrary-read primitive; the file must now be picked outside
/// the webview), then validate, copy into the app data dir, remember the
/// path in settings, and return it. The stored file is what later launches
/// load from — the original can be deleted by the user without breaking us.
fn import_art(slot: &ArtSlot, app: &AppHandle, db: &State<'_, DbState>) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .add_filter(
            "Images",
            &ALLOWED.iter().map(|(e, _)| *e).collect::<Vec<_>>(),
        )
        .blocking_pick_file()
        .ok_or_else(|| "no image picked".to_string())?;
    let source = picked.into_path().map_err(|e| e.to_string())?;
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

    let data_dir = user_dirs::app_data_dir(app);
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    // Exactly one stored variant: remove siblings from a previous import so
    // the data dir never accumulates <stem>.{png,jpg,…} litter.
    remove_stored_files(&data_dir, slot.file_stem);
    let dest = data_dir.join(format!(
        "{}.{}",
        slot.file_stem,
        ext.to_ascii_lowercase()
    ));
    std::fs::copy(&source, &dest).map_err(|e| format!("couldn't copy the image: {e}"))?;
    let stored = dest.to_string_lossy().to_string();

    {
        let conn = db.0.lock();
        db::set_setting(&conn, slot.path_setting, &stored).map_err(|e| e.to_string())?;
        // One active image at a time: a custom upload replaces any preset.
        db::set_setting(&conn, slot.preset_setting, "").map_err(|e| e.to_string())?;
    }
    Ok(stored)
}

/// Select one of the bundled stock images (frontend asset, id-validated).
/// Choosing a preset retires any custom upload — again, one active image.
fn set_art_preset(
    slot: &ArtSlot,
    app: &AppHandle,
    db: &State<'_, DbState>,
    id: &str,
) -> Result<(), String> {
    if !PRESET_IDS.contains(&id) {
        return Err(format!("unknown art preset '{id}'"));
    }
    let data_dir = user_dirs::app_data_dir(app);
    remove_stored_files(&data_dir, slot.file_stem);
    {
        let conn = db.0.lock();
        db::set_setting(&conn, slot.preset_setting, id).map_err(|e| e.to_string())?;
        db::set_setting(&conn, slot.path_setting, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The stored image as a `data:` URL for CSS backgrounds, or None when unset.
/// Data URL rather than `convertFileSrc`: no asset-protocol scope changes, and
/// it works identically in dev and production.
fn read_art_data(slot: &ArtSlot, db: &State<'_, DbState>) -> Result<Option<String>, String> {
    let path = {
        let conn = db.0.lock();
        db::get_setting(&conn, slot.path_setting)
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

/// Remove ALL images for a slot (custom file + setting, and the preset
/// selection). The UI falls back to plain.
fn clear_art(slot: &ArtSlot, app: &AppHandle, db: &State<'_, DbState>) -> Result<(), String> {
    let data_dir = user_dirs::app_data_dir(app);
    remove_stored_files(&data_dir, slot.file_stem);
    let conn = db.0.lock();
    db::set_setting(&conn, slot.path_setting, "").map_err(|e| e.to_string())?;
    db::set_setting(&conn, slot.preset_setting, "").map_err(|e| e.to_string())?;
    Ok(())
}

// --- Sidebar header art ---

/// Import a picked sidebar-header image (backend-owned native dialog).
#[tauri::command(async)]
pub fn import_sidebar_art(
    app: AppHandle,
    db: State<'_, DbState>,
) -> Result<String, String> {
    import_art(&SIDEBAR_ART, &app, &db)
}

/// Select a bundled stock sidebar image by id (replaces any custom upload).
#[tauri::command(async)]
pub fn set_sidebar_art_preset(
    app: AppHandle,
    db: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    set_art_preset(&SIDEBAR_ART, &app, &db, &id)
}

/// The stored sidebar image as a `data:` URL, or None when unset.
#[tauri::command(async)]
pub fn read_sidebar_art_data(db: State<'_, DbState>) -> Result<Option<String>, String> {
    read_art_data(&SIDEBAR_ART, &db)
}

/// Remove ALL sidebar art; the header falls back to plain.
#[tauri::command(async)]
pub fn clear_sidebar_art(app: AppHandle, db: State<'_, DbState>) -> Result<(), String> {
    clear_art(&SIDEBAR_ART, &app, &db)
}

/// The stored sidebar path itself — used by tests and diagnostics; the UI
/// reads the data URL instead.
#[tauri::command(async)]
pub fn get_sidebar_art_path(db: State<'_, DbState>) -> Result<Option<String>, String> {
    let conn = db.0.lock();
    Ok(db::get_setting(&conn, SIDEBAR_ART.path_setting)
        .map_err(|e| e.to_string())?
        .filter(|s| !s.trim().is_empty()))
}

// --- App wallpaper (background image behind the whole UI) ---

/// Import a picked wallpaper image (backend-owned native dialog).
#[tauri::command(async)]
pub fn import_app_wallpaper(
    app: AppHandle,
    db: State<'_, DbState>,
) -> Result<String, String> {
    import_art(&APP_WALLPAPER, &app, &db)
}

/// Select a bundled stock wallpaper by id (replaces any custom upload).
#[tauri::command(async)]
pub fn set_app_wallpaper_preset(
    app: AppHandle,
    db: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    set_art_preset(&APP_WALLPAPER, &app, &db, &id)
}

/// The stored wallpaper as a `data:` URL, or None when unset.
#[tauri::command(async)]
pub fn read_app_wallpaper_data(db: State<'_, DbState>) -> Result<Option<String>, String> {
    read_art_data(&APP_WALLPAPER, &db)
}

/// Remove the wallpaper entirely; the app falls back to the flat palette.
#[tauri::command(async)]
pub fn clear_app_wallpaper(app: AppHandle, db: State<'_, DbState>) -> Result<(), String> {
    clear_art(&APP_WALLPAPER, &app, &db)
}
