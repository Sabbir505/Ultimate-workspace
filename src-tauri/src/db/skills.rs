//! Skills + quick actions table groups.
//!
//! All query functions take `&Connection` for in-memory testability.

use rusqlite::{params, Connection};

use crate::types::*;
use super::{new_id, now_ts, DbResult};

// ---- skills ----

fn map_skill(row: &rusqlite::Row) -> rusqlite::Result<Skill> {
    Ok(Skill {
        id: row.get("id")?,
        name: row.get("name")?,
        slash_command: row.get("slash_command")?,
        content: row.get("content")?,
        scope: row.get("scope")?,
        created_at: row.get("created_at")?,
    })
}

/// Global skills plus, when `project_id` is given, that project's skills.
pub fn list_skills(conn: &Connection, project_id: Option<&str>) -> DbResult<Vec<Skill>> {
    match project_id {
        Some(pid) => {
            let mut stmt = conn.prepare(
                "SELECT * FROM skills WHERE scope = 'global' OR scope = ?1 ORDER BY created_at DESC",
            )?;
            let rows = stmt.query_map(params![pid], map_skill)?;
            rows.collect()
        }
        None => {
            let mut stmt =
                conn.prepare("SELECT * FROM skills WHERE scope = 'global' ORDER BY created_at DESC")?;
            let rows = stmt.query_map([], map_skill)?;
            rows.collect()
        }
    }
}

pub fn create_skill(
    conn: &Connection,
    name: &str,
    slash_command: &str,
    content: &str,
    scope: &str,
) -> DbResult<Skill> {
    let id = new_id();
    let now = now_ts();
    conn.execute(
        "INSERT INTO skills (id, name, slash_command, content, scope, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, slash_command, content, scope, now],
    )?;
    conn.query_row("SELECT * FROM skills WHERE id = ?1", params![id], map_skill)
}

pub fn update_skill(
    conn: &Connection,
    id: &str,
    name: &str,
    slash_command: &str,
    content: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE skills SET name = ?2, slash_command = ?3, content = ?4 WHERE id = ?1",
        params![id, name, slash_command, content],
    )?;
    Ok(())
}

pub fn delete_skill(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM skills WHERE id = ?1", params![id])?;
    Ok(())
}

// ---- quick actions ----

fn map_quick_action(row: &rusqlite::Row) -> rusqlite::Result<QuickAction> {
    Ok(QuickAction {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        label: row.get("label")?,
        command: row.get("command")?,
        keybinding: row.get("keybinding")?,
        run_on_worktree: row.get("run_on_worktree")?,
    })
}

pub fn list_quick_actions(conn: &Connection, project_id: &str) -> DbResult<Vec<QuickAction>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM quick_actions WHERE project_id = ?1 ORDER BY rowid",
    )?;
    let rows = stmt.query_map(params![project_id], map_quick_action)?;
    rows.collect()
}

pub fn create_quick_action(
    conn: &Connection,
    project_id: &str,
    label: &str,
    command: &str,
    keybinding: Option<&str>,
    run_on_worktree: bool,
) -> DbResult<QuickAction> {
    let id = new_id();
    conn.execute(
        "INSERT INTO quick_actions (id, project_id, label, command, keybinding, run_on_worktree)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, project_id, label, command, keybinding, run_on_worktree],
    )?;
    conn.query_row(
        "SELECT * FROM quick_actions WHERE id = ?1",
        params![id],
        map_quick_action,
    )
}

pub fn update_quick_action(
    conn: &Connection,
    id: &str,
    label: &str,
    command: &str,
    keybinding: Option<&str>,
    run_on_worktree: bool,
) -> DbResult<()> {
    conn.execute(
        "UPDATE quick_actions SET label = ?2, command = ?3, keybinding = ?4, run_on_worktree = ?5 WHERE id = ?1",
        params![id, label, command, keybinding, run_on_worktree],
    )?;
    Ok(())
}

pub fn delete_quick_action(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM quick_actions WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use super::*;

    #[test]
    fn skill_round_trip_and_scoping() {
        let conn = super::super::mem();
        let p = super::super::add_project(&conn, "/tmp/a", "a", false).unwrap();
        create_skill(&conn, "g1", "/g1", "body", "global").unwrap();
        create_skill(&conn, "p1", "/p1", "body", &p.id).unwrap();

        // No project -> only globals.
        assert_eq!(list_skills(&conn, None).unwrap().len(), 1);
        // With project -> globals + project skills.
        assert_eq!(list_skills(&conn, Some(&p.id)).unwrap().len(), 2);

        let all = list_skills(&conn, Some(&p.id)).unwrap();
        update_skill(&conn, &all[0].id, "renamed", "/renamed", "new body").unwrap();
        delete_skill(&conn, &all[1].id).unwrap();
        assert_eq!(list_skills(&conn, Some(&p.id)).unwrap().len(), 1);
    }

    #[test]
    fn quick_action_round_trip() {
        let conn = super::super::mem();
        let p = super::super::add_project(&conn, "/tmp/a", "a", false).unwrap();
        let qa = create_quick_action(&conn, &p.id, "dev", "npm run dev", Some("Ctrl+D"), true).unwrap();
        assert!(qa.run_on_worktree);
        assert_eq!(qa.keybinding.as_deref(), Some("Ctrl+D"));

        update_quick_action(&conn, &qa.id, "build", "npm run build", None, false).unwrap();
        let list = list_quick_actions(&conn, &p.id).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "build");
        assert!(!list[0].run_on_worktree);
        assert!(list[0].keybinding.is_none());

        delete_quick_action(&conn, &qa.id).unwrap();
        assert!(list_quick_actions(&conn, &p.id).unwrap().is_empty());
    }
}