//! OS toast notifications under the app's own identity (Windows).
//!
//! tauri-plugin-notification only passes the app's AppUserModelID when the
//! exe is NOT under `target/{debug,release}` (i.e. installed builds only) —
//! in dev runs notify-rust falls back to its documented PowerShell AUMID, so
//! toasts arrived branded "Windows PowerShell" with the PS logo. This module
//! registers the app's own AUMID in HKCU (`Software\Classes\AppUserModelId`,
//! the same unpackaged-app registration Windows Community Toolkit's
//! ToastNotificationCompat performs) with a DisplayName + IconUri, then
//! raises toasts under it — the toast bears Relay's name and logo on every
//! build type.

#[cfg(windows)]

/// Raise an OS toast bearing the app identity. Windows only; other platforms
/// keep using the notification plugin (see src/lib/notify.ts).
#[cfg(windows)]
#[tauri::command]
pub fn os_toast(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    let aumid = app.config().identifier.clone();
    let display_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "Relay".to_string());
    let icon_uri = {
        let path = ensure_icon_file(&app)?;
        url::Url::from_file_path(&path)
            .map_err(|_| "app icon path is not absolute")?
            .to_string()
    };
    ensure_aumid_registered(&aumid, &display_name, &icon_uri)?;
    tauri_winrt_notification::Toast::new(&aumid)
        .title(&title)
        .text1(&body)
        .sound(Some(tauri_winrt_notification::Sound::Default))
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn os_toast(_title: String, _body: String) -> Result<(), String> {
    Ok(())
}

/// Write the AUMID registration (DisplayName + IconUri) under HKCU. Idempotent
/// per toast — cheap registry writes, and they self-heal if the user deletes
/// the key.
#[cfg(windows)]
fn ensure_aumid_registered(aumid: &str, display_name: &str, icon_uri: &str) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(format!(r"Software\Classes\AppUserModelId\{aumid}"))
        .map_err(|e| e.to_string())?;
    key.set_value("DisplayName", &display_name)
        .map_err(|e| e.to_string())?;
    key.set_value("IconUri", &icon_uri).map_err(|e| e.to_string())?;
    Ok(())
}

/// Materialize the app icon as a PNG under the app-data dir (once) — the
/// AUMID's IconUri needs a file URI, and the embedded window icon is the one
/// asset guaranteed to exist on every build type.
#[cfg(windows)]
fn ensure_icon_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::user_dirs::app_data_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("toast-icon.png");
    if !path.exists() {
        let icon = app
            .default_window_icon()
            .ok_or("app has no default window icon")?;
        write_png(&path, icon.rgba(), icon.width(), icon.height())?;
    }
    Ok(path)
}

#[cfg(windows)]
fn write_png(path: &std::path::Path, rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut encoder = png::Encoder::new(file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    // Visual smoke test (pops a real OS toast — run explicitly):
    //   cargo test --manifest-path src-tauri/Cargo.toml --lib os_toast -- --ignored --nocapture
    // Registers the AUMID and raises the exact toast the bug report showed
    // ("Terminal is waiting for input"); it must display Relay + its icon,
    // not Windows PowerShell.
    #[test]
    #[ignore]
    fn toast_shows_under_app_identity() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let src = std::path::Path::new(manifest).join("icons/icon.png");

        // Decode the app icon PNG → RGBA (the runtime command uses the
        // embedded window icon; same pixels).
        let file = std::fs::File::open(&src).expect("open icon.png");
        let mut decoder = png::Decoder::new(file);
        decoder.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = decoder.read_info().expect("read png info");
        let mut buf = vec![0u8; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).expect("decode png");
        let rgba = &buf[..info.buffer_size()];

        let icon_path = std::env::temp_dir().join("relay-toast-icon.png");
        write_png(&icon_path, rgba, info.width, info.height).expect("write png");
        let icon_uri = url::Url::from_file_path(&icon_path)
            .expect("icon uri")
            .to_string();

        let aumid = "dev.relay.app";
        ensure_aumid_registered(aumid, "Relay", &icon_uri).expect("register aumid");
        tauri_winrt_notification::Toast::new(aumid)
            .title("Relay")
            .text1("Terminal is waiting for input")
            .sound(Some(tauri_winrt_notification::Sound::Default))
            .show()
            .expect("show toast");
    }
}
