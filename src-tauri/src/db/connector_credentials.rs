//! Connector credentials table (app-scoped, like the chat API key store).
//!
//! The *secret* token values (access + refresh tokens) live in the OS keychain
//! (see `secrets.rs`), never in this table. The row here only holds
//! non-sensitive metadata a connected-connector list needs cheaply: the
//! connector id, the expiry timestamp, the granted scopes, a displayable
//! account name, and when the connection was made.
//!
//! Why app-scoped and not per-project: a Notion account is one identity used
//! across every chat, mirroring how chat provider API keys are stored (see
//! `secrets.rs` `conduit:chat:<provider>` namespace). Per-conversation opt-in
//! is handled separately by the `chat_session_connectors` join, not by the
//! credential row.
//!
//! All query functions take `&Connection` for in-memory testability.

use rusqlite::{params, Connection, OptionalExtension};

use super::DbResult;

pub fn upsert_connector_credential_row(
    conn: &Connection,
    connector_id: &str,
    expires_at: Option<i64>,
    granted_scopes: Option<&str>,
    account_display: Option<&str>,
    connected_at: i64,
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO connector_credentials
            (connector_id, expires_at, granted_scopes, account_display, connected_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(connector_id) DO UPDATE SET
            expires_at = excluded.expires_at,
            granted_scopes = excluded.granted_scopes,
            account_display = excluded.account_display,
            connected_at = excluded.connected_at",
        params![connector_id, expires_at, granted_scopes, account_display, connected_at],
    )?;
    Ok(())
}

pub fn delete_connector_credential_row(conn: &Connection, connector_id: &str) -> DbResult<()> {
    conn.execute(
        "DELETE FROM connector_credentials WHERE connector_id = ?1",
        params![connector_id],
    )?;
    Ok(())
}

/// Non-secret metadata for a connected connector. The actual token values are
/// read from the keychain by `secrets::connector_load`.
pub struct ConnectorCredentialRow {
    pub connector_id: String,
    pub expires_at: Option<i64>,
    pub granted_scopes: Option<String>,
    pub account_display: Option<String>,
    pub connected_at: i64,
}

pub fn get_connector_credential_row(
    conn: &Connection,
    connector_id: &str,
) -> DbResult<Option<ConnectorCredentialRow>> {
    Ok(conn
        .query_row(
            "SELECT connector_id, expires_at, granted_scopes, account_display, connected_at
             FROM connector_credentials WHERE connector_id = ?1",
            params![connector_id],
            |r| {
                Ok(ConnectorCredentialRow {
                    connector_id: r.get(0)?,
                    expires_at: r.get(1)?,
                    granted_scopes: r.get(2)?,
                    account_display: r.get(3)?,
                    connected_at: r.get(4)?,
                })
            },
        )
        .optional()?)
}

pub fn list_connector_credential_rows(conn: &Connection) -> DbResult<Vec<ConnectorCredentialRow>> {
    let mut stmt = conn.prepare(
        "SELECT connector_id, expires_at, granted_scopes, account_display, connected_at
         FROM connector_credentials ORDER BY connected_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ConnectorCredentialRow {
            connector_id: r.get(0)?,
            expires_at: r.get(1)?,
            granted_scopes: r.get(2)?,
            account_display: r.get(3)?,
            connected_at: r.get(4)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_rows_round_trip() {
        let conn = super::super::mem();
        upsert_connector_credential_row(&conn, "notion", Some(123), Some("a b"), Some("me@x"), 100).unwrap();
        upsert_connector_credential_row(&conn, "notion", Some(999), Some("c"), Some("me@y"), 200).unwrap(); // upsert
        upsert_connector_credential_row(&conn, "gdrive", None, None, None, 150).unwrap();

        let rows = list_connector_credential_rows(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        // ordered by connected_at DESC → notion (200) before gdrive (150)
        assert_eq!(rows[0].connector_id, "notion");
        assert_eq!(rows[0].account_display.as_deref(), Some("me@y"));
        assert_eq!(rows[0].expires_at, Some(999));

        let one = get_connector_credential_row(&conn, "gdrive").unwrap().unwrap();
        assert!(one.expires_at.is_none());

        delete_connector_credential_row(&conn, "notion").unwrap();
        assert!(get_connector_credential_row(&conn, "notion")
            .unwrap()
            .is_none());
    }
}
