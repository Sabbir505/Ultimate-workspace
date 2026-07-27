//! Workspaces table — save/restore pane layouts per project.
//!
//! A workspace captures the full pane grid state (harness type, session ids,
//! split fractions, browser URLs) as a JSON blob keyed by project + name,
//! so users can snapshot and later restore a layout.

use rusqlite::{params, Connection};

use super::{now_ts, DbResult};
use crate::types::WorkspaceRecord;

fn map_workspace(row: &rusqlite::Row) -> rusqlite::Result<WorkspaceRecord> {
    Ok(WorkspaceRecord {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        name: row.get("name")?,
        data: row.get("data")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn list_workspaces(conn: &Connection, project_id: &str) -> DbResult<Vec<WorkspaceRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM workspaces WHERE project_id = ?1 ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map(params![project_id], map_workspace)?;
    rows.collect()
}

pub fn get_workspace(conn: &Connection, id: &str) -> DbResult<WorkspaceRecord> {
    conn.query_row(
        "SELECT * FROM workspaces WHERE id = ?1",
        params![id],
        map_workspace,
    )
}

pub fn create_workspace(
    conn: &Connection,
    id: &str,
    project_id: &str,
    name: &str,
    data: &str,
) -> DbResult<()> {
    let now = now_ts();
    conn.execute(
        "INSERT INTO workspaces (id, project_id, name, data, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, project_id, name, data, now],
    )?;
    Ok(())
}

pub fn update_workspace(conn: &Connection, id: &str, name: &str, data: &str) -> DbResult<()> {
    let now = now_ts();
    conn.execute(
        "UPDATE workspaces SET name = ?2, data = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, name, data, now],
    )?;
    Ok(())
}

pub fn delete_workspace(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
    Ok(())
}