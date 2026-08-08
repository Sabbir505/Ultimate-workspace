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
        estimated_cost_usd: row.get("estimated_cost_usd")?,
    })
}

pub fn insert_cost_event(conn: &Connection, session_id: &str, usage: &UsageInfo) -> DbResult<i64> {
    conn.execute(
        "INSERT INTO cost_events (session_id, timestamp, input_tokens, output_tokens, estimated_cost_usd)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            session_id,
            now_ts(),
            usage.input_tokens,
            usage.output_tokens,
            usage.cost_usd
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn get_cost_events(conn: &Connection, session_id: Option<&str>) -> DbResult<Vec<CostEvent>> {
    match session_id {
        Some(sid) => {
            let mut stmt = conn.prepare(
                "SELECT * FROM cost_events WHERE session_id = ?1 ORDER BY timestamp",
            )?;
            let rows = stmt.query_map(params![sid], map_cost_event)?;
            rows.collect()
        }
        None => {
            let mut stmt = conn.prepare("SELECT * FROM cost_events ORDER BY timestamp")?;
            let rows = stmt.query_map([], map_cost_event)?;
            rows.collect()
        }
    }
}

pub fn get_cost_rollups(conn: &Connection) -> DbResult<CostRollups> {
    let per_project = {
        let mut stmt = conn.prepare(
            "SELECT s.project_id,
                    COALESCE(SUM(ce.estimated_cost_usd), 0.0),
                    COALESCE(SUM(ce.input_tokens), 0),
                    COALESCE(SUM(ce.output_tokens), 0)
             FROM cost_events ce
             JOIN sessions s ON s.id = ce.session_id
             GROUP BY s.project_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ProjectCostRollup {
                project_id: r.get(0)?,
                total_cost_usd: r.get(1)?,
                total_input_tokens: r.get(2)?,
                total_output_tokens: r.get(3)?,
            })
        })?;
        rows.collect::<DbResult<Vec<_>>>()?
    };
    let daily = {
        // date(timestamp,'unixepoch') yields 'YYYY-MM-DD' per CONTRACT.md.
        let mut stmt = conn.prepare(
            "SELECT date(timestamp, 'unixepoch') AS day,
                    COALESCE(SUM(estimated_cost_usd), 0.0)
             FROM cost_events
             GROUP BY day
             ORDER BY day",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(DailyCost {
                day: r.get(0)?,
                cost_usd: r.get(1)?,
            })
        })?;
        rows.collect::<DbResult<Vec<_>>>()?
    };
    Ok(CostRollups { per_project, daily })
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use crate::harness_adapters::UsageInfo;
    use super::*;

    #[test]
    fn cost_events_and_rollups() {
        let conn = super::super::mem();
        let p1 = super::super::add_project(&conn, "/tmp/a", "a", false).unwrap();
        let p2 = super::super::add_project(&conn, "/tmp/b", "b", false).unwrap();
        let s1 = super::super::create_session(&conn, &p1.id, "claude_code").unwrap();
        let s2 = super::super::create_session(&conn, &p2.id, "kimi_code").unwrap();

        insert_cost_event(&conn, &s1.id, &UsageInfo { input_tokens: Some(100), output_tokens: Some(50), cost_usd: Some(0.10), ..Default::default() }).unwrap();
        insert_cost_event(&conn, &s1.id, &UsageInfo { input_tokens: Some(200), output_tokens: None, cost_usd: Some(0.20), ..Default::default() }).unwrap();
        insert_cost_event(&conn, &s2.id, &UsageInfo { input_tokens: None, output_tokens: Some(5), cost_usd: None, ..Default::default() }).unwrap();

        assert_eq!(get_cost_events(&conn, Some(&s1.id)).unwrap().len(), 2);
        assert_eq!(get_cost_events(&conn, None).unwrap().len(), 3);

        let rollups = get_cost_rollups(&conn).unwrap();
        assert_eq!(rollups.per_project.len(), 2);
        let r1 = rollups.per_project.iter().find(|r| r.project_id == p1.id).unwrap();
        assert!((r1.total_cost_usd - 0.30).abs() < 1e-9);
        assert_eq!(r1.total_input_tokens, 300);
        assert_eq!(r1.total_output_tokens, 50);
        let r2 = rollups.per_project.iter().find(|r| r.project_id == p2.id).unwrap();
        assert_eq!(r2.total_input_tokens, 0); // COALESCE null -> 0
        // Both events share today's date -> exactly one daily bucket.
        assert_eq!(rollups.daily.len(), 1);
        assert!((rollups.daily[0].cost_usd - 0.30).abs() < 1e-9);
        // day format YYYY-MM-DD
        assert_eq!(rollups.daily[0].day.len(), 10);
    }
}