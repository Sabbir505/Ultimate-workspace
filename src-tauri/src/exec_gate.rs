//! Native confirmation gate for renderer-initiated process execution.
//!
//! Three IPC surfaces execute whatever string the webview sends — `spawn_shell`
//! (a shell command line), MCP-gallery custom server installs (an arbitrary
//! command + args + env), and `set_llama_server_path` (an executable Relay will
//! spawn for local-model sessions). The code comments on those surfaces have
//! long said "callers are responsible for not letting untrusted model output
//! flow into this argument" — this module gives them a real gate instead:
//!
//! 1. The decision is remembered per identifying detail (working folder /
//!    command line / exe path), so a trusted setup asks exactly once.
//! 2. Unknown combos raise a NATIVE OS dialog — outside the webview, so a
//!    compromised renderer cannot answer it, style it away, or auto-click it.
//! 3. "Allow" remembers for that identifier; "Deny" refuses without recording
//!    anything (the next attempt asks again).
//!
//! Sealed storage (§4.1.4): the remembered decision used to be the literal
//! string "1" in the `app_settings` table under `exec.allow.<kind>.<hash>` —
//! anything that could write the DB could pre-allow execution. The value is
//! now an HMAC-SHA256 tag over `kind` + `ident`, keyed by a random 32-byte
//! key that lives in the OS keychain (`secrets::platform_store`, namespace
//! `execgate`). A DB row without the matching keychain key cannot be forged,
//! and [`migrate_legacy`] drops the pre-existing plain-"1" rows once at boot,
//! after which a plain value is never accepted. If the keychain is
//! unavailable, remembering degrades to "ask every time" (fail-safe) —
//! nothing plain is ever written. (On Linux's no-keyring XOR fallback the
//! key is only obfuscated in the same DB — the same weaker tier the rest of
//! the secrets stack already documents there; Windows/macOS get the real
//! keychain.)

use hmac::{Hmac, Mac};
use rand::RngCore;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::db;
use crate::secrets;

type HmacSha256 = Hmac<Sha256>;

/// Keychain namespace + key holding the sealing key (32 random bytes, hex).
const SEAL_NAMESPACE: &str = "execgate";
const SEAL_KEY_NAME: &str = "hmac_key";
/// Version prefix + domain-separation string for the sealed values.
const SEAL_PREFIX: &str = "v1:";
const SEAL_DOMAIN: &str = "exec.allow.v1";

/// Settings key for one remembered approval. `ident` may be long (a full
/// command line), so it is folded into a short stable hash — the
/// human-readable detail lives in the dialog, not in the key.
fn allow_key(kind: &str, ident: &str) -> String {
    let digest = Sha256::digest(format!("{kind}\u{0}{ident}").as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("exec.allow.{kind}.{hex}")
}

/// Load (creating on first use) the 32-byte sealing key from the keychain.
/// `None` = unavailable (checks then fail closed). No process cache: the
/// load is one keychain read per exec attempt (attempts are dialog-gated
/// and rare), and no cache keeps a `platform_remove` observable immediately.
fn seal_key(conn: &Connection) -> Option<Vec<u8>> {
    match secrets::platform_load(conn, SEAL_NAMESPACE, SEAL_KEY_NAME) {
        Some(hex) => match hex_to_bytes(&hex) {
            Some(bytes) if bytes.len() == 32 => Some(bytes),
            _ => {
                // Corrupt/short key in the keychain: rotate it. Old approvals
                // stop verifying (ask again) — the fail-safe direction.
                generate_and_store_key(conn)
            }
        },
        None => generate_and_store_key(conn),
    }
}

fn generate_and_store_key(conn: &Connection) -> Option<Vec<u8>> {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    if secrets::platform_store(conn, SEAL_NAMESPACE, SEAL_KEY_NAME, &hex).is_err() {
        return None;
    }
    Some(bytes.to_vec())
}

fn hex_to_bytes(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// The HMAC tag over the domain, kind, and ident — hex-encoded with the
/// version prefix. `None` when the sealing key is unavailable.
fn seal_value(conn: &Connection, kind: &str, ident: &str) -> Option<String> {
    let key = seal_key(conn)?;
    let mut mac = HmacSha256::new_from_slice(&key).ok()?;
    mac.update(SEAL_DOMAIN.as_bytes());
    mac.update(&[0u8]);
    mac.update(kind.as_bytes());
    mac.update(&[0u8]);
    mac.update(ident.as_bytes());
    let tag = mac.finalize().into_bytes();
    let hex: String = tag.iter().map(|b| format!("{b:02x}")).collect();
    Some(format!("{SEAL_PREFIX}{hex}"))
}

/// True when this kind/ident combo was already allowed (and remembered with
/// a valid seal). A plain legacy "1", a row sealed under a different
/// keychain key (restored DB on a new machine), or a forged value all read
/// as NOT allowed — the dialog asks again.
pub fn is_allowed(conn: &Connection, kind: &str, ident: &str) -> bool {
    let Some(stored) = db::get_setting(conn, &allow_key(kind, ident)).ok().flatten() else {
        return false;
    };
    let Some(expected) = seal_value(conn, kind, ident) else {
        return false; // no keychain key → cannot verify → fail closed
    };
    stored == expected
}

/// Record a standing approval for this kind/ident combo. Best-effort: when
/// the sealing key is unavailable nothing is written and the next attempt
/// asks again (never store an unsealed value).
pub fn remember(conn: &Connection, kind: &str, ident: &str) {
    if let Some(sealed) = seal_value(conn, kind, ident) {
        let _ = db::set_setting(conn, &allow_key(kind, ident), &sealed);
    } else {
        crate::relay_eprintln!(
            "[exec-gate] keychain unavailable — approval for {kind} not remembered (will re-ask)"
        );
    }
}

/// One-time boot migration: drop every `exec.allow.*` row whose value is not
/// a seal written by this build. The legacy plain-"1" rows (and any forged
/// value) cannot be re-verified during migration — kind/ident are not
/// recoverable from the hash key — so the honest recovery is to drop them
/// and re-ask. Shape-correct seals survive (their tag is still fully
/// verified against kind+ident at check time by [`is_allowed`], which is
/// where forge-resistance actually lives: without the keychain key no
/// writer can mint a tag that verifies).
pub fn migrate_legacy(conn: &Connection) {
    let keys: Vec<String> = match conn
        .prepare("SELECT key FROM app_settings WHERE key LIKE 'exec.allow.%'")
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
        })
    {
        Ok(keys) => keys,
        Err(e) => {
            crate::relay_eprintln!("[exec-gate] legacy migration scan failed: {e}");
            return;
        }
    };
    for key in keys {
        let looks_sealed = db::get_setting(conn, &key)
            .ok()
            .flatten()
            .is_some_and(|v| v.starts_with(SEAL_PREFIX) && v.len() == SEAL_PREFIX.len() + 64);
        if !looks_sealed {
            let _ = db::delete_setting(conn, &key);
        }
    }
}

fn blocking_show(app: &AppHandle, title: &str, body: &str) -> bool {
    app.dialog()
        .message(body.to_string())
        .title(title.to_string())
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Allow".to_string(),
            "Deny".to_string(),
        ))
        .blocking_show()
}

/// Ask via a native dialog (off the main thread) and remember on Allow.
/// Returns `Ok(true)` when already remembered or the user allowed; `Ok(false)`
/// when denied (callers surface a "blocked" error); `Err` when the dialog
/// itself could not be shown (fail closed — treat as denied).
pub async fn confirm_remembered(
    db: &std::sync::Arc<parking_lot::Mutex<Connection>>,
    app: &AppHandle,
    kind: &str,
    ident: &str,
    title: &str,
    body: String,
) -> Result<bool, String> {
    {
        let conn = db.lock();
        if is_allowed(&conn, kind, ident) {
            return Ok(true);
        }
    }
    let app = app.clone();
    let title = title.to_string();
    let allowed =
        tauri::async_runtime::spawn_blocking(move || blocking_show(&app, &title, &body))
            .await
            .map_err(|e| format!("confirmation dialog failed: {e}"))?;
    if allowed {
        let conn = db.lock();
        remember(&conn, kind, ident);
    }
    Ok(allowed)
}

/// Sync variant for `#[tauri::command(async)]` plain `fn` commands, which run
/// on the thread pool (never the UI thread) — see the MAIN-THREAD RULE in
/// lib.rs. Same remember-on-allow contract as [`confirm_remembered`]; a failed
/// dialog is fail-closed (`false`).
pub fn confirm_remembered_sync(
    db: &std::sync::Arc<parking_lot::Mutex<Connection>>,
    app: &AppHandle,
    kind: &str,
    ident: &str,
    title: &str,
    body: &str,
) -> bool {
    {
        let conn = db.lock();
        if is_allowed(&conn, kind, ident) {
            return true;
        }
    }
    if !blocking_show(app, title, body) {
        return false;
    }
    let conn = db.lock();
    remember(&conn, kind, ident);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::init_schema(&conn).unwrap();
        conn
    }

    /// These tests share the REAL OS keychain entry (namespace `execgate`),
    /// and cargo runs tests in one process on many threads — the key-removal
    /// test would yank the key out from under a concurrent seal/verify. The
    /// same pattern as installed_skills' ENV_LOCK: hold this for the whole
    /// body of any test that touches the sealing key.
    static KEYCHAIN_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    #[test]
    fn remembered_approval_stores_a_sealed_value_not_a_bare_one() {
        let _guard = KEYCHAIN_LOCK.lock();
        let conn = mem();
        assert!(!is_allowed(&conn, "shell", "cargo build"));
        remember(&conn, "shell", "cargo build");
        assert!(is_allowed(&conn, "shell", "cargo build"));

        let key = allow_key("shell", "cargo build");
        let stored = db::get_setting(&conn, &key).unwrap().unwrap();
        assert!(
            stored.starts_with(SEAL_PREFIX) && stored.len() == SEAL_PREFIX.len() + 64,
            "stored value must be a v1 HMAC seal, got {stored:?}"
        );

        // A different ident/kind must not verify against this row's value.
        assert!(!is_allowed(&conn, "shell", "cargo test"));
        assert!(!is_allowed(&conn, "mcp", "cargo build"));
    }

    #[test]
    fn plain_one_is_never_accepted() {
        let _guard = KEYCHAIN_LOCK.lock();
        // The attack the seal exists for: a DB writer plants "1".
        let conn = mem();
        db::set_setting(&conn, &allow_key("shell", "rm -rf"), "1").unwrap();
        assert!(
            !is_allowed(&conn, "shell", "rm -rf"),
            "a plain 1 must never read as allowed"
        );
        // Same for a random-looking non-seal string.
        db::set_setting(&conn, &allow_key("shell", "rm -rf"), "v1:deadbeef").unwrap();
        assert!(!is_allowed(&conn, "shell", "rm -rf"));
    }

    #[test]
    fn migrated_legacy_rows_are_dropped_and_legacy_values_rejected() {
        let _guard = KEYCHAIN_LOCK.lock();
        let conn = mem();
        db::set_setting(&conn, &allow_key("hook", "pre-existing"), "1").unwrap();
        migrate_legacy(&conn);
        // We cannot re-derive kind/ident from the hash key, so the legacy row
        // is dropped (re-ask), never converted into a standing approval.
        assert!(
            db::get_setting(&conn, &allow_key("hook", "pre-existing"))
                .unwrap()
                .is_none(),
            "legacy plain-1 row must be removed by migration"
        );
        assert!(!is_allowed(&conn, "hook", "pre-existing"));

        // Shape-correct seals survive the migration sweep.
        remember(&conn, "hook", "kept");
        migrate_legacy(&conn);
        assert!(is_allowed(&conn, "hook", "kept"), "valid seal must survive");
    }

    #[test]
    fn seal_rejects_when_the_keychain_key_is_gone() {
        let _guard = KEYCHAIN_LOCK.lock();
        let conn = mem();
        remember(&conn, "sidecar", "llama-server.exe");
        assert!(is_allowed(&conn, "sidecar", "llama-server.exe"));
        // Losing the key (new machine, keychain reset) must fail closed for
        // seals minted under the OLD key...
        secrets::platform_remove(&conn, SEAL_NAMESPACE, SEAL_KEY_NAME);
        assert!(
            !is_allowed(&conn, "sidecar", "llama-server.exe"),
            "without the keychain key the seal cannot verify"
        );
        // ...and the next remember() mints a FRESH key (the new-machine case)
        // and stores under it — never a plain value.
        remember(&conn, "sidecar", "llama-server.exe");
        assert!(is_allowed(&conn, "sidecar", "llama-server.exe"));
        let stored = db::get_setting(&conn, &allow_key("sidecar", "llama-server.exe"))
            .unwrap()
            .unwrap();
        assert!(
            stored.starts_with(SEAL_PREFIX),
            "re-sealed under the fresh key, not plain"
        );
    }
}
