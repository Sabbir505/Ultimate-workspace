//! Per-project secrets store (PRD §7.16).
//!
//! Design: the SQLite `project_secrets` table only ever stores the *key names*
//! (plus a small marker blob); the actual values live in the OS keychain
//! (Windows Credential Manager / macOS Keychain) under service
//! `dev.relay.app`, account `relay:<project_id>:<key>`. Entries written by
//! pre-rebrand builds (service `dev.conduit.app`, accounts `conduit:…`) are
//! read as a fallback and cleaned up on delete.
//!
//! Why this split: keychain entries are the encrypted-at-rest source of truth
//! (the PRD's preferred approach), while the table gives us cheap per-project
//! key listing without enumerating the OS keychain (which most keychain APIs
//! don't support).
//!
//! Linux fallback: no keyring backend is enabled for Linux in Cargo.toml, so
//! there values are stored obfuscated (XOR, not encryption) directly in the
//! table. This deviation is logged in BUILD_LOG.md.
//!
//! Values are only ever read back for environment injection in `spawn_shell`
//! when the caller passes `injectSecretsProjectId` — and are never logged.
//!
//! Chat API keys use a separate app-scoped namespace: account
//! `relay:chat:<provider>` under service `dev.relay.app`. These keys are
//! NEVER returned to the frontend via any IPC command — they are only read
//! by the Rust backend for outbound HTTP requests.
//!
//! Connector OAuth tokens use a third app-scoped namespace: account
//! `relay:connector:<connector_id>:<field>` where `<field>` is
//! `access_token` or `refresh_token`. Only the Rust backend ever reads them
//! (to authorize calls to the connector's remote MCP server); the frontend
//! only ever learns the *metadata* (expiry, scopes, account name) via the
//! `connector_credentials` table — never the token bytes.

use rusqlite::Connection;

use crate::db;

const SERVICE_NAME: &str = "dev.relay.app";

/// Keychain service under which entries were written before the identifier
/// rebrand (`dev.conduit.app`, accounts `conduit:…`, and briefly `relay:…`).
/// Read as a fallback and cleaned up on delete — never newly written.
const LEGACY_SERVICE_NAME: &str = "dev.conduit.app";

/// Pre-rebrand account name for `account` (entries were written as
/// `conduit:…` under the same service before 0.4). Used as a read-side
/// fallback and for removal cleanup only — nothing new is written under it.
fn legacy_of(account: &str) -> String {
    account.replacen("relay:", "conduit:", 1)
}

/// Marker written to `value_encrypted` when the real value is in the keychain.
const KEYRING_MARKER: &[u8] = b"keyring:v1";

fn account(project_id: &str, key: &str) -> String {
    format!("relay:{project_id}:{key}")
}

pub fn set_secret(conn: &Connection, project_id: &str, key: &str, value: &str) -> Result<(), String> {
    platform::store(project_id, key, value)?;
    let blob = platform::stored_blob(value);
    if let Err(e) = db::upsert_secret_row(conn, project_id, key, &blob) {
        // The keychain entry is unlisted without its DB row — remove it so a
        // failed registry write doesn't leave an orphaned secret behind (L11).
        platform::remove(project_id, key);
        return Err(e.to_string());
    }
    Ok(())
}

pub fn delete_secret(conn: &Connection, project_id: &str, key: &str) -> Result<(), String> {
    // Best-effort keychain removal: a missing entry is not an error.
    platform::remove(project_id, key);
    db::delete_secret_row(conn, project_id, key).map_err(|e| e.to_string())
}

pub fn list_secret_keys(conn: &Connection, project_id: &str) -> Result<Vec<String>, String> {
    db::list_secret_keys(conn, project_id).map_err(|e| e.to_string())
}

/// All (key, value) pairs for environment injection. Keys whose value can't be
/// retrieved (e.g. keychain entry deleted out from under us) are silently
/// skipped — a missing env var beats a failed spawn.
pub fn secrets_for_injection(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<(String, String)>, String> {
    let keys = list_secret_keys(conn, project_id)?;
    let mut out = Vec::new();
    for key in keys {
        if let Some(value) = platform::load(conn, project_id, &key) {
            out.push((key, value));
        }
    }
    Ok(out)
}

// ---- OS keychain backend (Windows / macOS) ----

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
mod platform {
    use super::{
        account, legacy_of, KEYRING_MARKER, LEGACY_SERVICE_NAME, SERVICE_NAME,
    };
    use keyring::Entry;
    use rusqlite::Connection;

    fn read_entry(service: &str, account: &str) -> Option<String> {
        Entry::new(service, account)
            .ok()?
            .get_password()
            .ok()
    }

    /// Reads the newest generation first and falls back to the pre-rebrand
    /// generations so existing installs keep working without a keychain
    /// migration; new writes always use the current service + account.
    fn read_entry_either(account: impl Fn() -> String) -> Option<String> {
        let account = account();
        read_entry(SERVICE_NAME, &account)
            .or_else(|| read_entry(LEGACY_SERVICE_NAME, &account))
            .or_else(|| read_entry(LEGACY_SERVICE_NAME, &legacy_of(&account)))
    }

    fn remove_entry(service: &str, account: &str) {
        if let Ok(entry) = Entry::new(service, account) {
            let _ = entry.delete_credential();
        }
    }

    fn remove_all_generations(account: &str) {
        remove_entry(SERVICE_NAME, account);
        remove_entry(LEGACY_SERVICE_NAME, account);
        remove_entry(LEGACY_SERVICE_NAME, &legacy_of(account));
    }

    pub fn store(project_id: &str, key: &str, value: &str) -> Result<(), String> {
        Entry::new(SERVICE_NAME, &account(project_id, key))
            .map_err(|e| e.to_string())?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    pub fn load(_conn: &Connection, project_id: &str, key: &str) -> Option<String> {
        read_entry_either(|| account(project_id, key))
    }

    pub fn remove(project_id: &str, key: &str) {
        remove_all_generations(&account(project_id, key));
    }

    /// The table row is only a name registry on keychain platforms.
    pub fn stored_blob(_value: &str) -> Vec<u8> {
        KEYRING_MARKER.to_vec()
    }

    // ---- Chat API keys (app-scoped, same service) ----

    pub fn chat_store(_conn: &Connection, provider: &str, value: &str) -> Result<(), String> {
        Entry::new(SERVICE_NAME, &super::chat_account(provider))
            .map_err(|e| e.to_string())?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    pub fn chat_load(_conn: &Connection, provider: &str) -> Option<String> {
        read_entry_either(|| super::chat_account(provider))
    }

    pub fn chat_remove(_conn: &Connection, provider: &str) {
        remove_all_generations(&super::chat_account(provider));
    }

    // ---- Connector OAuth tokens (app-scoped, per-field keychain entries) ----

    pub fn connector_store(
        _conn: &Connection,
        connector_id: &str,
        field: &str,
        value: &str,
    ) -> Result<(), String> {
        Entry::new(SERVICE_NAME, &super::connector_account(connector_id, field))
            .map_err(|e| e.to_string())?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    pub fn connector_load(
        _conn: &Connection,
        connector_id: &str,
        field: &str,
    ) -> Option<String> {
        read_entry_either(|| super::connector_account(connector_id, field))
    }

    pub fn connector_remove(_conn: &Connection, connector_id: &str, field: &str) {
        remove_all_generations(&super::connector_account(connector_id, field));
    }

    // ---- Arbitrary app-scoped namespace/key store ----

    pub fn generic_store(
        _conn: &Connection,
        namespace: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        Entry::new(SERVICE_NAME, &super::generic_account(namespace, key))
            .map_err(|e| e.to_string())?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    pub fn generic_load(
        _conn: &Connection,
        namespace: &str,
        key: &str,
    ) -> Option<String> {
        read_entry_either(|| super::generic_account(namespace, key))
    }

    pub fn generic_remove(_conn: &Connection, namespace: &str, key: &str) {
        remove_all_generations(&super::generic_account(namespace, key));
    }
}

// ---- Fallback (no keyring backend) : obfuscated-at-rest in SQLite ----
// Linux: now uses the OS keyring (Secret Service via D-Bus) via the
// keychain `mod platform` block above (cfg includes target_os = "linux").
// The XOR fallback below only applies to platforms where no keyring crate
// backend is configured. Today: none — every supported target has a real
// keychain, so this `cfg` excludes all of them and the block is dead code.
//
// XOR is NOT encryption; it just hides values from a casual `strings | grep`
// pass. The table is the encrypted-at-rest source of truth on keychain
// platforms (the keychain is the real source; the table holds a marker blob
// to enumerate keys cheaply without enumerating the OS keychain).

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod platform {
    use super::account;
    use crate::db;
    use rusqlite::{Connection, OptionalExtension};

    const OBFUSCATION_KEY: &[u8] = b"nexus-local-secrets-obfuscation-v1";

    fn xor(data: &[u8]) -> Vec<u8> {
        data.iter()
            .enumerate()
            .map(|(i, b)| b ^ OBFUSCATION_KEY[i % OBFUSCATION_KEY.len()])
            .collect()
    }

    pub fn store(_project_id: &str, _key: &str, _value: &str) -> Result<(), String> {
        Ok(()) // value goes into the table row instead — see stored_blob
    }

    pub fn load(conn: &Connection, project_id: &str, key: &str) -> Option<String> {
        let blob = db::get_secret_blob(conn, project_id, key).ok()??;
        String::from_utf8(xor(&blob)).ok()
    }

    pub fn remove(_project_id: &str, _key: &str) {}

    pub fn stored_blob(value: &str) -> Vec<u8> {
        xor(value.as_bytes())
    }

    // ---- Chat API keys (app-scoped, XOR-obfuscated in chat_secrets table) ----

    fn ensure_chat_secrets_table(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chat_secrets (
                provider TEXT PRIMARY KEY,
                value_encrypted BLOB NOT NULL
            )",
        )
        .map_err(|e| e.to_string())
    }

    pub fn chat_store(conn: &Connection, provider: &str, value: &str) -> Result<(), String> {
        ensure_chat_secrets_table(conn)?;
        let blob = xor(value.as_bytes());
        conn.execute(
            "INSERT INTO chat_secrets (provider, value_encrypted) VALUES (?1, ?2)
             ON CONFLICT(provider) DO UPDATE SET value_encrypted = excluded.value_encrypted",
            rusqlite::params![provider, blob],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn chat_load(conn: &Connection, provider: &str) -> Option<String> {
        ensure_chat_secrets_table(conn).ok()?;
        let blob: Vec<u8> = conn
            .query_row(
                "SELECT value_encrypted FROM chat_secrets WHERE provider = ?1",
                rusqlite::params![provider],
                |r| r.get(0),
            )
            .optional()
            .ok()??;
        String::from_utf8(xor(&blob)).ok()
    }

    pub fn chat_remove(conn: &Connection, provider: &str) {
        let _ = conn.execute(
            "DELETE FROM chat_secrets WHERE provider = ?1",
            rusqlite::params![provider],
        );
    }

    // ---- Connector OAuth tokens (app-scoped, XOR-obfuscated in table) ----

    fn ensure_connector_secrets_table(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS connector_secrets (
                connector_id TEXT NOT NULL,
                field TEXT NOT NULL,
                value_encrypted BLOB NOT NULL,
                PRIMARY KEY (connector_id, field)
            )",
        )
        .map_err(|e| e.to_string())
    }

    pub fn connector_store(
        conn: &Connection,
        connector_id: &str,
        field: &str,
        value: &str,
    ) -> Result<(), String> {
        ensure_connector_secrets_table(conn)?;
        let blob = xor(value.as_bytes());
        conn.execute(
            "INSERT INTO connector_secrets (connector_id, field, value_encrypted) VALUES (?1, ?2, ?3)
             ON CONFLICT(connector_id, field) DO UPDATE SET value_encrypted = excluded.value_encrypted",
            rusqlite::params![connector_id, field, blob],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn connector_load(
        conn: &Connection,
        connector_id: &str,
        field: &str,
    ) -> Option<String> {
        ensure_connector_secrets_table(conn).ok()?;
        let blob: Vec<u8> = conn
            .query_row(
                "SELECT value_encrypted FROM connector_secrets
                 WHERE connector_id = ?1 AND field = ?2",
                rusqlite::params![connector_id, field],
                |r| r.get(0),
            )
            .optional()
            .ok()??;
        String::from_utf8(xor(&blob)).ok()
    }

    pub fn connector_remove(conn: &Connection, connector_id: &str, field: &str) {
        let _ = conn.execute(
            "DELETE FROM connector_secrets WHERE connector_id = ?1 AND field = ?2",
            rusqlite::params![connector_id, field],
        );
    }

    // ---- Arbitrary app-scoped namespace/key store ----

    pub fn generic_store(
        conn: &Connection,
        namespace: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        ensure_generic_secrets_table(conn)?;
        let blob = xor(value.as_bytes());
        conn.execute(
            "INSERT INTO generic_secrets (namespace, key, value_encrypted) VALUES (?1, ?2, ?3)
             ON CONFLICT(namespace, key) DO UPDATE SET value_encrypted = excluded.value_encrypted",
            rusqlite::params![namespace, key, blob],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn generic_load(conn: &Connection, namespace: &str, key: &str) -> Option<String> {
        ensure_generic_secrets_table(conn).ok()?;
        let blob: Vec<u8> = conn
            .query_row(
                "SELECT value_encrypted FROM generic_secrets WHERE namespace = ?1 AND key = ?2",
                rusqlite::params![namespace, key],
                |r| r.get(0),
            )
            .optional()
            .ok()??;
        String::from_utf8(xor(&blob)).ok()
    }

    pub fn generic_remove(conn: &Connection, namespace: &str, key: &str) {
        let _ = conn.execute(
            "DELETE FROM generic_secrets WHERE namespace = ?1 AND key = ?2",
            rusqlite::params![namespace, key],
        );
    }

    fn ensure_generic_secrets_table(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS generic_secrets (
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                value_encrypted BLOB NOT NULL,
                PRIMARY KEY (namespace, key)
            )",
        )
        .map_err(|e| e.to_string())
    }
}

#[allow(dead_code)]
fn _account_used(project_id: &str, key: &str) -> String {
    account(project_id, key)
}

// ---- Chat API key store (app-scoped, separate from per-project secrets) ----

fn chat_account(provider: &str) -> String {
    format!("relay:chat:{provider}")
}

/// Store a chat provider API key in the OS keychain. The value is NEVER
/// returned to the frontend via any IPC command — it is only used by the
/// Rust backend for outbound HTTP requests to the LLM provider.
/// On Linux the `conn` is used for the obfuscated-at-rest fallback.
pub fn set_chat_api_key(conn: &Connection, provider: &str, value: &str) -> Result<(), String> {
    platform::chat_store(conn, provider, value)
}

pub fn get_chat_api_key(conn: &Connection, provider: &str) -> Option<String> {
    platform::chat_load(conn, provider)
}

/// True when a chat API key exists for this provider (keychain entry or
/// table row). Used to decide whether a model-only / baseUrl-only update
/// is allowed without the user re-entering their key.
pub fn has_chat_api_key(conn: &Connection, provider: &str) -> bool {
    platform::chat_load(conn, provider).is_some()
}

pub fn delete_chat_api_key(conn: &Connection, provider: &str) -> Result<(), String> {
    platform::chat_remove(conn, provider);
    Ok(())
}

// ---- Connector OAuth token store (app-scoped, third namespace) ----

fn connector_account(connector_id: &str, field: &str) -> String {
    format!("relay:connector:{connector_id}:{field}")
}

/// Store a connector OAuth token field (`access_token` / `refresh_token`) in
/// the OS keychain. Never returned to the frontend — read only by the Rust
/// backend to authorize MCP server calls. On Linux the `conn` is used for
/// the obfuscated-at-rest fallback.
pub fn set_connector_token(
    conn: &Connection,
    connector_id: &str,
    field: &str,
    value: &str,
) -> Result<(), String> {
    platform::connector_store(conn, connector_id, field, value)
}

pub fn get_connector_token(
    conn: &Connection,
    connector_id: &str,
    field: &str,
) -> Option<String> {
    platform::connector_load(conn, connector_id, field)
}

/// Best-effort removal of both access + refresh tokens for a connector.
pub fn delete_connector_tokens(conn: &Connection, connector_id: &str) -> Result<(), String> {
    platform::connector_remove(conn, connector_id, "access_token");
    platform::connector_remove(conn, connector_id, "refresh_token");
    Ok(())
}

// ---- Arbitrary namespace/key secret store (app-scoped) ----
//
// Used by features that don't fit the per-project or per-chat namespaces
// above — e.g. the Hugging Face token for the Local Models market. Like
// the other stores, values are kept out of the SQLite table on platforms
// with a real keychain and obfuscated as a last-resort fallback.
fn generic_account(namespace: &str, key: &str) -> String {
    format!("relay:{namespace}:{key}")
}

/// Store an arbitrary app-scoped secret in the OS keychain (or the
/// obfuscated table on platforms without one). The value is never
/// returned to the frontend.
pub fn platform_store(
    conn: &Connection,
    namespace: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    platform::generic_store(conn, namespace, key, value)
}

pub fn platform_load(
    conn: &Connection,
    namespace: &str,
    key: &str,
) -> Option<String> {
    platform::generic_load(conn, namespace, key)
}

pub fn platform_remove(conn: &Connection, namespace: &str, key: &str) {
    platform::generic_remove(conn, namespace, key);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::init_schema(&conn).unwrap();
        db::add_project(&conn, "/tmp/a", "a", false).unwrap();
        conn
    }

    #[test]
    fn key_registry_round_trip() {
        let conn = mem();
        let project = db::list_projects(&conn).unwrap().remove(0);
        // On keychain platforms this writes to the real OS keychain under a
        // throwaway account; acceptable for a unit test, and cleaned up after.
        set_secret(&conn, &project.id, "RELAY_TEST_KEY", "test-value").unwrap();
        let keys = list_secret_keys(&conn, &project.id).unwrap();
        assert_eq!(keys, vec!["RELAY_TEST_KEY"]);
        let injected = secrets_for_injection(&conn, &project.id).unwrap();
        assert_eq!(
            injected,
            vec![("RELAY_TEST_KEY".to_string(), "test-value".to_string())]
        );
        delete_secret(&conn, &project.id, "RELAY_TEST_KEY").unwrap();
        assert!(list_secret_keys(&conn, &project.id).unwrap().is_empty());
    }
}
