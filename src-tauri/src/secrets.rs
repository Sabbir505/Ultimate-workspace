//! Per-project secrets store (PRD §7.16).
//!
//! Design: the SQLite `project_secrets` table only ever stores the *key names*
//! (plus a small marker blob); the actual values live in the OS keychain
//! (Windows Credential Manager / macOS Keychain) under service
//! `dev.conduit.app`, account `conduit:<project_id>:<key>`.
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
//! `conduit:chat:<provider>` under service `dev.conduit.app`. These keys are
//! NEVER returned to the frontend via any IPC command — they are only read
//! by the Rust backend for outbound HTTP requests.

use rusqlite::Connection;

use crate::db;

const SERVICE_NAME: &str = "dev.conduit.app";

/// Marker written to `value_encrypted` when the real value is in the keychain.
const KEYRING_MARKER: &[u8] = b"keyring:v1";

fn account(project_id: &str, key: &str) -> String {
    format!("conduit:{project_id}:{key}")
}

pub fn set_secret(conn: &Connection, project_id: &str, key: &str, value: &str) -> Result<(), String> {
    platform::store(project_id, key, value)?;
    let blob = platform::stored_blob(value);
    db::upsert_secret_row(conn, project_id, key, &blob).map_err(|e| e.to_string())
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

#[cfg(any(windows, target_os = "macos"))]
mod platform {
    use super::{account, KEYRING_MARKER, SERVICE_NAME};
    use keyring::Entry;
    use rusqlite::Connection;

    pub fn store(project_id: &str, key: &str, value: &str) -> Result<(), String> {
        Entry::new(SERVICE_NAME, &account(project_id, key))
            .map_err(|e| e.to_string())?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    pub fn load(_conn: &Connection, project_id: &str, key: &str) -> Option<String> {
        let entry = Entry::new(SERVICE_NAME, &account(project_id, key)).ok()?;
        entry.get_password().ok()
    }

    pub fn remove(project_id: &str, key: &str) {
        if let Ok(entry) = Entry::new(SERVICE_NAME, &account(project_id, key)) {
            let _ = entry.delete_credential();
        }
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
        let entry = Entry::new(SERVICE_NAME, &super::chat_account(provider)).ok()?;
        entry.get_password().ok()
    }

    pub fn chat_remove(_conn: &Connection, provider: &str) {
        if let Ok(entry) = Entry::new(SERVICE_NAME, &super::chat_account(provider)) {
            let _ = entry.delete_credential();
        }
    }
}

// ---- Linux (and other) fallback: obfuscated-at-rest in SQLite ----
// NOT encryption — there is no enabled keyring backend for this target.
// Deviation from PRD §7.16 logged in BUILD_LOG.md.

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::account;
    use crate::db;
    use rusqlite::Connection;

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
        let blob: Option<Vec<u8>> = conn
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
}

#[allow(dead_code)]
fn _account_used(project_id: &str, key: &str) -> String {
    account(project_id, key)
}

// ---- Chat API key store (app-scoped, separate from per-project secrets) ----

fn chat_account(provider: &str) -> String {
    format!("conduit:chat:{provider}")
}

// ---- Hardcoded test configuration ----
// These values are used as fallback when no user-configured key exists.
// This allows testing the chat without manually entering API credentials.
const HARDCODED_BASE_URL: &str = "https://ai2.18.show";
const HARDCODED_API_KEY: &str = "sk-84fe0942e39eb903e53254883a9d97cf0d1dada54003299336adface8b1f3000";
const HARDCODED_MODEL: &str = "kimi-k2.6";
const HARDCODED_PROVIDER: &str = "openai_compatible";

/// Store a chat provider API key in the OS keychain. The value is NEVER
/// returned to the frontend via any IPC command — it is only used by the
/// Rust backend for outbound HTTP requests to the LLM provider.
/// On Linux the `conn` is used for the obfuscated-at-rest fallback.
pub fn set_chat_api_key(conn: &Connection, provider: &str, value: &str) -> Result<(), String> {
    platform::chat_store(conn, provider, value)
}

pub fn get_chat_api_key(conn: &Connection, provider: &str) -> Option<String> {
    // Return user-configured key if it exists, otherwise fall back to hardcoded
    // test credentials for the openai_compatible provider.
    platform::chat_load(conn, provider).or_else(|| {
        if provider == HARDCODED_PROVIDER {
            Some(HARDCODED_API_KEY.to_string())
        } else {
            None
        }
    })
}

/// True when a chat API key exists for this provider (keychain entry or
/// table row). Used to decide whether a model-only / baseUrl-only update
/// is allowed without the user re-entering their key.
pub fn has_chat_api_key(conn: &Connection, provider: &str) -> bool {
    platform::chat_load(conn, provider).is_some()
        || provider == HARDCODED_PROVIDER
}

pub fn delete_chat_api_key(conn: &Connection, provider: &str) -> Result<(), String> {
    platform::chat_remove(conn, provider);
    Ok(())
}

/// Returns the hardcoded base URL for testing when no user config exists.
pub fn get_hardcoded_base_url(provider: &str) -> Option<String> {
    if provider == HARDCODED_PROVIDER {
        Some(HARDCODED_BASE_URL.to_string())
    } else {
        None
    }
}

/// Returns the hardcoded model for testing when no user config exists.
pub fn get_hardcoded_model(provider: &str) -> Option<String> {
    if provider == HARDCODED_PROVIDER {
        Some(HARDCODED_MODEL.to_string())
    } else {
        None
    }
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
        set_secret(&conn, &project.id, "CONDUIT_TEST_KEY", "test-value").unwrap();
        let keys = list_secret_keys(&conn, &project.id).unwrap();
        assert_eq!(keys, vec!["CONDUIT_TEST_KEY"]);
        let injected = secrets_for_injection(&conn, &project.id).unwrap();
        assert_eq!(
            injected,
            vec![("CONDUIT_TEST_KEY".to_string(), "test-value".to_string())]
        );
        delete_secret(&conn, &project.id, "CONDUIT_TEST_KEY").unwrap();
        assert!(list_secret_keys(&conn, &project.id).unwrap().is_empty());
    }
}
