//! Projects + sessions table groups.
//!
//! Sessions are children of projects; they share this module so that
//! cascade logic (e.g. `remove_project`) lives in one place.
//!
//! All query functions take `&Connection` for in-memory testability.

use rusqlite::{params, Connection, OptionalExtension};

use crate::types::*;
use super::{new_id, now_ts, DbResult};

fn map_project(row: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get("id")?,
        path: row.get("path")?,
        name: row.get("name")?,
        is_git_repo: row.get("is_git_repo")?,
        created_at: row.get("created_at")?,
        last_opened_at: row.get("last_opened_at")?,
    })
}

/// Ordered by lastOpenedAt desc, NULLs last (CONTRACT.md).
pub fn list_projects(conn: &Connection) -> DbResult<Vec<Project>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM projects ORDER BY last_opened_at IS NULL, last_opened_at DESC",
    )?;
    let rows = stmt.query_map([], map_project)?;
    rows.collect()
}

/// Insert-or-return-existing on the UNIQUE path; always bumps last_opened_at.
pub fn add_project(conn: &Connection, path: &str, name: &str, is_git_repo: bool) -> DbResult<Project> {
    let now = now_ts();
    conn.execute(
        "INSERT INTO projects (id, path, name, is_git_repo, created_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(path) DO UPDATE SET last_opened_at = ?5",
        params![new_id(), path, name, is_git_repo, now],
    )?;
    conn.query_row("SELECT * FROM projects WHERE path = ?1", params![path], map_project)
}

/// Also removes the project's sessions, their cost events, quick actions,
/// secret key rows, and workspaces (CONTRACT.md). Foreign keys have no ON DELETE
/// CASCADE in the PRD schema, so the cleanup is explicit here.
pub fn remove_project(conn: &Connection, project_id: &str) -> DbResult<()> {
    conn.execute(
        "DELETE FROM cost_events WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?1)",
        params![project_id],
    )?;
    conn.execute("DELETE FROM sessions WHERE project_id = ?1", params![project_id])?;
    conn.execute("DELETE FROM quick_actions WHERE project_id = ?1", params![project_id])?;
    conn.execute("DELETE FROM project_secrets WHERE project_id = ?1", params![project_id])?;
    conn.execute("DELETE FROM workspaces WHERE project_id = ?1", params![project_id])?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
    Ok(())
}

pub fn rename_project(conn: &Connection, project_id: &str, name: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE projects SET name = ?2 WHERE id = ?1",
        params![project_id, name],
    )?;
    Ok(())
}

pub fn set_git_repo(conn: &Connection, project_id: &str, is_git_repo: bool) -> DbResult<()> {
    conn.execute(
        "UPDATE projects SET is_git_repo = ?2 WHERE id = ?1",
        params![project_id, is_git_repo],
    )?;
    Ok(())
}

pub fn get_project(conn: &Connection, project_id: &str) -> DbResult<Option<Project>> {
    conn.query_row(
        "SELECT * FROM projects WHERE id = ?1",
        params![project_id],
        map_project,
    )
    .optional()
}

// ---- sessions ----

fn map_session(row: &rusqlite::Row) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        harness: row.get("harness")?,
        harness_session_id: row.get("harness_session_id")?,
        title: row.get("title")?,
        worktree_path: row.get("worktree_path")?,
        created_at: row.get("created_at")?,
        last_active_at: row.get("last_active_at")?,
        status: row.get("status")?,
    })
}

/// Most recent first; `project_id = None` lists across all projects.
pub fn list_sessions(conn: &Connection, project_id: Option<&str>) -> DbResult<Vec<SessionRecord>> {
    match project_id {
        Some(pid) => {
            let mut stmt = conn.prepare(
                "SELECT * FROM sessions WHERE project_id = ?1 ORDER BY last_active_at DESC",
            )?;
            let rows = stmt.query_map(params![pid], map_session)?;
            rows.collect()
        }
        None => {
            let mut stmt =
                conn.prepare("SELECT * FROM sessions ORDER BY last_active_at DESC")?;
            let rows = stmt.query_map([], map_session)?;
            rows.collect()
        }
    }
}

pub fn create_session(conn: &Connection, project_id: &str, harness: &str) -> DbResult<SessionRecord> {
    let now = now_ts();
    let id = new_id();
    conn.execute(
        "INSERT INTO sessions (id, project_id, harness, harness_session_id, title, worktree_path, created_at, last_active_at, status)
         VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, ?4, 'idle')",
        params![id, project_id, harness, now],
    )?;
    conn.query_row("SELECT * FROM sessions WHERE id = ?1", params![id], map_session)
}

pub fn get_session(conn: &Connection, session_id: &str) -> DbResult<Option<SessionRecord>> {
    conn.query_row(
        "SELECT * FROM sessions WHERE id = ?1",
        params![session_id],
        map_session,
    )
    .optional()
}

pub fn get_session_with_project(
    conn: &Connection,
    session_id: &str,
) -> DbResult<Option<(SessionRecord, Project)>> {
    let session = match get_session(conn, session_id)? {
        Some(s) => s,
        None => return Ok(None),
    };
    let project = get_project(conn, &session.project_id)?;
    Ok(project.map(|p| (session, p)))
}

pub fn update_session_title(conn: &Connection, session_id: &str, title: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE sessions SET title = ?2 WHERE id = ?1",
        params![session_id, title],
    )?;
    Ok(())
}

pub fn delete_session(conn: &Connection, session_id: &str) -> DbResult<()> {
    conn.execute(
        "DELETE FROM cost_events WHERE session_id = ?1",
        params![session_id],
    )?;
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
    Ok(())
}

pub fn touch_session(conn: &Connection, session_id: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE sessions SET last_active_at = ?2 WHERE id = ?1",
        params![session_id, now_ts()],
    )?;
    Ok(())
}

pub fn set_session_harness_id(
    conn: &Connection,
    session_id: &str,
    harness_session_id: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE sessions SET harness_session_id = ?2 WHERE id = ?1",
        params![session_id, harness_session_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use crate::harness_adapters::UsageInfo;
    use super::*;

    #[test]
    fn project_round_trip_and_upsert() {
        let conn = super::super::mem();
        let p1 = add_project(&conn, "/tmp/a", "a", true).unwrap();
        assert!(p1.is_git_repo);
        assert_eq!(p1.last_opened_at, Some(p1.created_at));
        // Same path -> same project, last_opened refreshed, no duplicate.
        let p2 = add_project(&conn, "/tmp/a", "a", true).unwrap();
        assert_eq!(p1.id, p2.id);
        assert_eq!(list_projects(&conn).unwrap().len(), 1);
    }

    #[test]
    fn remove_project_cascades_manually() {
        let conn = super::super::mem();
        let p = add_project(&conn, "/tmp/a", "a", false).unwrap();
        let s = create_session(&conn, &p.id, "claude_code").unwrap();
        super::super::insert_cost_event(
            &conn,
            &s.id,
            &UsageInfo {
                input_tokens: Some(1),
                output_tokens: None,
                cost_usd: Some(0.01), ..Default::default()
            },
            "claude_code", "pty", Some(0.01),
        )
        .unwrap();
        super::super::create_quick_action(&conn, &p.id, "dev", "npm run dev", None, false).unwrap();
        super::super::upsert_secret_row(&conn, &p.id, "API_KEY", b"marker").unwrap();

        remove_project(&conn, &p.id).unwrap();
        assert!(list_projects(&conn).unwrap().is_empty());
        assert!(list_sessions(&conn, None).unwrap().is_empty());
        assert!(super::super::get_cost_events(&conn, None).unwrap().is_empty());
        assert!(super::super::list_quick_actions(&conn, &p.id).unwrap().is_empty());
        assert!(super::super::list_secret_keys(&conn, &p.id).unwrap().is_empty());
    }

    #[test]
    fn session_round_trip() {
        let conn = super::super::mem();
        let p = add_project(&conn, "/tmp/a", "a", false).unwrap();
        let s = create_session(&conn, &p.id, "kimi_code").unwrap();
        assert_eq!(s.harness, "kimi_code");
        assert_eq!(s.status, "idle");
        assert!(s.harness_session_id.is_none());

        set_session_harness_id(&conn, &s.id, "harness-123").unwrap();
        update_session_title(&conn, &s.id, "my title").unwrap();
        let s2 = get_session(&conn, &s.id).unwrap().unwrap();
        assert_eq!(s2.harness_session_id.as_deref(), Some("harness-123"));
        assert_eq!(s2.title.as_deref(), Some("my title"));

        let (s3, p3) = get_session_with_project(&conn, &s.id).unwrap().unwrap();
        assert_eq!(s3.id, s.id);
        assert_eq!(p3.id, p.id);

        delete_session(&conn, &s.id).unwrap();
        assert!(get_session(&conn, &s.id).unwrap().is_none());
    }
}