//! Cost events table group (token usage + cost tracking per session).
//!
//! All query functions take `&Connection` for in-memory testability.

use rusqlite::{params, Connection};

use crate::harness_adapters::UsageInfo;
use crate::types::*;
use super::{now_ts, DbResult};

fn map_cost_event(row: &rusqlite::Row) -> rusqlite::Result<CostEvent> {
    Ok(CostEvent {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        timestamp: row.get("timestamp")?,
        input_tokens: row.get("input_tokens")?,
        output_tokens: row.get("output_tokens")?,
        provider: row.get("provider")?,
        model_key: row.get("model_key")?,
        source: row.get("source")?,
        cache_creation_input_tokens: row.get("cache_creation_input_tokens")?,
        cache_read_input_tokens: row.get("cache_read_input_tokens")?,
        reasoning_output_tokens: row.get("reasoning_output_tokens")?,
        reported_cost_usd: row.get("reported_cost_usd")?,
        pricing_estimated_usd: row.get("pricing_estimated_usd")?,
    })
}

pub fn insert_cost_event(
    conn: &Connection,
    session_id: &str,
    usage: &UsageInfo,
    provider: &str,
    source: &str,
    pricing_estimated_usd: Option<f64>,
) -> DbResult<i64> {
    conn.execute(
        "INSERT INTO cost_events (
            session_id, timestamp,
            input_tokens, output_tokens,
            provider, source,
            cache_creation_input_tokens, cache_read_input_tokens, reasoning_output_tokens,
            reported_cost_usd, pricing_estimated_usd
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            session_id, now_ts(),
            usage.input_tokens, usage.output_tokens,
            provider, source,
            usage.cache_creation_input_tokens, usage.cache_read_input_tokens,
            usage.reasoning_output_tokens,
            usage.cost_usd, pricing_estimated_usd,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_cost_event_model_key(conn: &Connection, cost_event_id: i64, model_key: Option<&str>) -> DbResult<()> {
    conn.execute(
        "UPDATE cost_events SET model_key = ?1 WHERE id = ?2",
        params![model_key, cost_event_id],
    )?;
    Ok(())
}

pub fn get_cost_events(
    conn: &Connection,
    session_id: Option<&str>,
    limit: Option<i64>,
    before_ts: Option<i64>,
) -> DbResult<Vec<CostEvent>> {
    // M6: bounded by default — the unbounded form returned every event ever
    // recorded (months of rows) to the UI in one shot. Callers pass None for
    // backward compat, but the command layer always sets a cap.
    let lim = limit.unwrap_or(500);
    let mut sql = String::from("SELECT * FROM cost_events WHERE 1=1");
    if session_id.is_some() {
        sql.push_str(" AND session_id = ?1");
    }
    if before_ts.is_some() {
        sql.push_str(" AND timestamp < ?2");
    }
    sql.push_str(" ORDER BY timestamp DESC LIMIT ?3");
    let mut stmt = conn.prepare(&sql)?;
    let rows = match (session_id, before_ts) {
        (Some(sid), Some(b)) => stmt.query_map(params![sid, b, lim], map_cost_event)?,
        (Some(sid), None) => stmt.query_map(params![sid, i64::MAX, lim], map_cost_event)?,
        (None, Some(b)) => stmt.query_map(params!["", b, lim], map_cost_event)?,
        (None, None) => stmt.query_map(params!["", i64::MAX, lim], map_cost_event)?,
    };
    // Reverse so callers keep chronological order.
    let mut out: Vec<CostEvent> = rows.collect::<Result<_, _>>()?;
    out.reverse();
    Ok(out)
}

// NOTE: the rollup lives in cost_v2.rs (get_cost_rollups_v2) — read-time
// priced, never reading the write-only pricing_estimated_usd column. There is
// intentionally no legacy rollup shim here anymore.

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use crate::harness_adapters::UsageInfo;
    use super::*;

    #[test]
    fn cost_v2_migration_preserves_rows_and_adds_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        // Pre-migration schema: legacy cost_events with the old single cost column.
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, is_git_repo BOOLEAN NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_opened_at INTEGER);
             CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), harness TEXT NOT NULL, harness_session_id TEXT, title TEXT, worktree_path TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'idle', last_synced_at INTEGER);
             CREATE TABLE cost_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), timestamp INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL);
             INSERT INTO projects (id, path, name, created_at) VALUES ('p1', '/tmp/a', 'a', 0);
             INSERT INTO sessions (id, project_id, harness, created_at, last_active_at, last_synced_at) VALUES ('s1', 'p1', 'claude_code', 0, 0, 0);",
        ).unwrap();

        // Pre-migration row in the legacy shape.
        conn.execute(
            "INSERT INTO cost_events (session_id, timestamp, input_tokens, output_tokens, estimated_cost_usd)
             VALUES ('s1', 1000, 100, 50, 0.10)", []).unwrap();

        // model_key backfill requires a last_synced_at — which is only set when
        // the on-disk sync has run, so seed it to 0 here to make the backfill
        // fire.
        conn.execute("UPDATE sessions SET last_synced_at = 1 WHERE id = 's1'", []).unwrap();
        super::super::migrate_cost_v2(&conn).unwrap();

        // Old `estimated_cost_usd` is gone, new columns exist.
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(cost_events)").unwrap()
            .query_map([], |r| r.get::<_, String>(1)).unwrap()
            .filter_map(Result::ok).collect();
        assert!(!cols.contains(&"estimated_cost_usd".to_string()));
        assert!(cols.contains(&"provider".to_string()));
        assert!(cols.contains(&"model_key".to_string()));
        assert!(cols.contains(&"source".to_string()));
        assert!(cols.contains(&"cache_creation_input_tokens".to_string()));
        assert!(cols.contains(&"cache_read_input_tokens".to_string()));
        assert!(cols.contains(&"reasoning_output_tokens".to_string()));
        assert!(cols.contains(&"reported_cost_usd".to_string()));
        assert!(cols.contains(&"pricing_estimated_usd".to_string()));

        // The legacy row's tokens are preserved, model_key backfilled, source kept.
        let row: (Option<i64>, Option<i64>, String, Option<String>) = conn
            .query_row("SELECT input_tokens, output_tokens, source, model_key FROM cost_events", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        assert_eq!(row.0, Some(100));
        assert_eq!(row.1, Some(50));
        // Source is 'on_disk' here because the backfill runs once last_synced_at
        // is set (the same condition the migration checks for).
        assert_eq!(row.2, "on_disk");
        assert_eq!(row.3, Some("claude-sonnet-4-5".to_string()));
    }

    #[test]
    fn cost_events_and_rollups() {
        let conn = super::super::mem();
        let p1 = super::super::add_project(&conn, "/tmp/a", "a", false).unwrap();
        let p2 = super::super::add_project(&conn, "/tmp/b", "b", false).unwrap();
        let s1 = super::super::create_session(&conn, &p1.id, "claude_code").unwrap();
        let s2 = super::super::create_session(&conn, &p2.id, "kimi_code").unwrap();

        insert_cost_event(&conn, &s1.id, &UsageInfo { input_tokens: Some(100), output_tokens: Some(50), cost_usd: Some(0.10), ..Default::default() }, "claude_code", "pty", Some(0.10)).unwrap();
        insert_cost_event(&conn, &s1.id, &UsageInfo { input_tokens: Some(200), output_tokens: None, cost_usd: Some(0.20), ..Default::default() }, "claude_code", "pty", Some(0.20)).unwrap();
        insert_cost_event(&conn, &s2.id, &UsageInfo { input_tokens: None, output_tokens: Some(5), cost_usd: None, ..Default::default() }, "kimi_code", "pty", Some(0.0)).unwrap();

        assert_eq!(get_cost_events(&conn, Some(&s1.id), None, None).unwrap().len(), 2);
        assert_eq!(get_cost_events(&conn, None, None, None).unwrap().len(), 3);

        // Rollup invariants are covered by get_cost_rollups_v2 in cost_v2.rs
        // (read-time priced). Here we just assert the events round-trip.
        let events = get_cost_events(&conn, None, None, None).unwrap();
        assert_eq!(events.iter().filter(|e| e.session_id == s1.id).count(), 2);
        assert_eq!(events.iter().filter(|e| e.session_id == s2.id).count(), 1);
    }
}