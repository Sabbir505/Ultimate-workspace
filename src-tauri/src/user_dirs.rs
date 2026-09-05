//! User-visible directories and app identity paths, including all
//! pre-rebrand (Conduit → Relay) compatibility.
//!
//! Existing installs keep their data: every default below prefers the new
//! name and falls back to the legacy folder only when that is the sole
//! occupant, so fresh setups get the new layout and nothing moves behind the
//! user's back. The app data dir itself migrates once (rename) — see
//! [`ensure_app_data_dir`].

use std::path::{Path, PathBuf};

const APP_DIR: &str = "Relay";
const LEGACY_APP_DIR: &str = "Conduit";

/// Current bundle identifier (tauri.conf.json `identifier`). Also the OS
/// keychain service name and the toast AppUserModelID.
pub const APP_IDENTIFIER: &str = "dev.relay.app";
/// Identifier before the rebrand. Its app data dir is migrated once; its
/// keychain entries are read and cleaned up, never newly written.
pub const LEGACY_APP_IDENTIFIER: &str = "dev.conduit.app";

/// `base/Relay`, or `base/Conduit` when only the legacy folder exists.
pub(crate) fn branded_dir(base: &Path) -> PathBuf {
    let new_dir = base.join(APP_DIR);
    if new_dir.exists() || !base.join(LEGACY_APP_DIR).exists() {
        new_dir
    } else {
        base.join(LEGACY_APP_DIR)
    }
}

/// The legacy `base/Conduit` directory when it exists (used for read-side
/// scanning — e.g. models — where both layouts should be covered).
pub(crate) fn legacy_dir(base: &Path) -> Option<PathBuf> {
    let dir = base.join(LEGACY_APP_DIR);
    dir.exists().then_some(dir)
}

/// Default models dir: `~/Relay/models`, or the legacy `~/Conduit/models`
/// when that's the only one that exists.
pub(crate) fn default_models_dir(home: &Path) -> PathBuf {
    let new_dir = home.join(APP_DIR).join("models");
    if new_dir.exists() || !home.join(LEGACY_APP_DIR).join("models").exists() {
        new_dir
    } else {
        home.join(LEGACY_APP_DIR).join("models")
    }
}

// ---- app data dir (bundle identifier) migration ----

/// App data dir for GUI call sites: whatever Tauri resolves from the bundle
/// identifier, passed through the once-per-process migration check.
pub fn app_data_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let new_dir = app.path().app_data_dir().unwrap_or_else(|_| {
        dirs::data_dir()
            .unwrap_or_else(|| std::env::temp_dir())
            .join(APP_IDENTIFIER)
    });
    resolve_app_data_dir(new_dir)
}

/// App data dir without an AppHandle (headless automation binary, early
/// GUI warm-up before the builder exists). Must match Tauri's resolution:
/// `<OS data dir>/<identifier>`.
pub fn app_data_dir_default() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| std::env::temp_dir());
    resolve_app_data_dir(base.join(APP_IDENTIFIER))
}

/// Cached per process so the legacy-vs-new decision can't flip mid-session
/// (half the state must never land in the old dir and half in the new one).
fn resolve_app_data_dir(new_dir: PathBuf) -> PathBuf {
    use once_cell::sync::OnceCell;
    static ACTIVE: OnceCell<PathBuf> = OnceCell::new();
    ACTIVE
        .get_or_init(|| {
            let legacy = new_dir.with_file_name(LEGACY_APP_IDENTIFIER);
            ensure_app_data_dir(&new_dir, &legacy)
        })
        .clone()
}

/// One-time relocation of the pre-rebrand app data dir. The DB file is the
/// anchor: if the new dir already holds one (migrated, or a fresh install
/// that has run), nothing moves; if only the legacy dir does, it is renamed
/// into place (atomic on the same volume). A legacy dir locked by the
/// headless automation runner degrades to copying the DB files out, and as a
/// last resort this session keeps using the legacy dir — the next launch
/// retries. Every app-data consumer must resolve through this, never via
/// `app_data_dir()` directly.
fn ensure_app_data_dir(new_dir: &Path, legacy: &Path) -> PathBuf {
    if has_db(new_dir) || !has_db(legacy) {
        return new_dir.to_path_buf();
    }
    if try_rename(legacy, new_dir) {
        return new_dir.to_path_buf();
    }
    // Rename failed (legacy locked) — either a concurrent migrator just won
    // (then the DB is already there) or the dir is busy: copy the DB out.
    if has_db(new_dir) || copy_db_files(legacy, new_dir) {
        return new_dir.to_path_buf();
    }
    legacy.to_path_buf()
}

fn has_db(dir: &Path) -> bool {
    dir.join("relay.db").exists() || dir.join("conduit.db").exists()
}

fn try_rename(from: &Path, to: &Path) -> bool {
    for _ in 0..10 {
        if std::fs::rename(from, to).is_ok() {
            return true;
        }
        // A concurrent relay-automation run can hold the legacy dir for a
        // few seconds — give it a chance to finish before degrading.
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    false
}

/// Last-resort copy of just the database files from the locked legacy dir.
/// A live automation writer could make this snapshot torn, but the
/// alternative is the user appearing to lose every chat.
fn copy_db_files(from: &Path, to: &Path) -> bool {
    let _ = std::fs::create_dir_all(to);
    let mut copied = false;
    for name in [
        "relay.db",
        "relay.db-wal",
        "relay.db-shm",
        "conduit.db",
        "conduit.db-wal",
        "conduit.db-shm",
    ] {
        let src = from.join(name);
        if src.exists() && std::fs::copy(&src, to.join(name)).is_ok() {
            copied = true;
        }
    }
    copied
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_base_uses_new_name() {
        let tmp = std::env::temp_dir().join(format!("relay-user-dirs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert_eq!(branded_dir(&tmp), tmp.join("Relay"));
        assert_eq!(default_models_dir(&tmp), tmp.join("Relay").join("models"));
        assert_eq!(legacy_dir(&tmp), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn legacy_only_base_keeps_legacy() {
        let tmp = std::env::temp_dir().join(format!("relay-user-dirs-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("Conduit")).unwrap();
        assert_eq!(branded_dir(&tmp), tmp.join("Conduit"));
        std::fs::create_dir_all(tmp.join("Conduit").join("models")).unwrap();
        assert_eq!(default_models_dir(&tmp), tmp.join("Conduit").join("models"));
        assert_eq!(legacy_dir(&tmp), Some(tmp.join("Conduit")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn both_dirs_prefer_new() {
        let tmp =
            std::env::temp_dir().join(format!("relay-user-dirs-both-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("Conduit")).unwrap();
        std::fs::create_dir_all(tmp.join("Relay")).unwrap();
        assert_eq!(branded_dir(&tmp), tmp.join("Relay"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn write_db(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), b"sqlite").unwrap();
    }

    #[test]
    fn app_data_fresh_install_stays_new() {
        let base = temp_base("appdata-fresh");
        let new_dir = base.join("dev.relay.app");
        assert_eq!(ensure_app_data_dir(&new_dir, &base.join("dev.conduit.app")), new_dir);
        assert!(!new_dir.exists(), "fresh install must not create anything");
        cleanup(&base);
    }

    #[test]
    fn app_data_legacy_only_renames_into_place() {
        let base = temp_base("appdata-legacy");
        let legacy = base.join("dev.conduit.app");
        let new_dir = base.join("dev.relay.app");
        write_db(&legacy, "conduit.db");
        assert_eq!(ensure_app_data_dir(&new_dir, &legacy), new_dir);
        assert!(!legacy.exists(), "renamed, not copied");
        assert!(new_dir.join("conduit.db").exists(), "db rides along");
        cleanup(&base);
    }

    #[test]
    fn app_data_already_migrated_is_untouched() {
        let base = temp_base("appdata-done");
        let legacy = base.join("dev.conduit.app");
        let new_dir = base.join("dev.relay.app");
        write_db(&new_dir, "relay.db");
        write_db(&legacy, "conduit.db");
        assert_eq!(ensure_app_data_dir(&new_dir, &legacy), new_dir);
        assert!(legacy.exists(), "legacy data must not be deleted once new exists");
        assert!(new_dir.join("relay.db").exists());
        cleanup(&base);
    }

    #[test]
    fn app_data_copy_fallback_puts_db_in_new_dir() {
        let base = temp_base("appdata-copy");
        let legacy = base.join("dev.conduit.app");
        let new_dir = base.join("dev.relay.app");
        write_db(&legacy, "conduit.db");
        assert!(copy_db_files(&legacy, &new_dir));
        assert!(new_dir.join("conduit.db").exists());
        assert!(legacy.join("conduit.db").exists(), "copy leaves the original");
        cleanup(&base);
    }

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("relay-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }
}
