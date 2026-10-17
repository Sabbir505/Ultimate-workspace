// bot_approvals — the queue behind "background bot runs never execute
// write-class tools" (docs/architecture/BOTS.md §Unattended permissions).
//
// A standing job, `run_bot` or `ask_bot` run has no human watching, and its
// input may be untrusted (a webhook, a file that changed on disk). So when such
// a run reaches a write-class tool, the call is NOT executed: a row lands here
// and the owner approves or denies it from the Bots view (or the phone).
//
// `summary` is built deterministically from the tool name + declared arguments
// by chat::bot_policy::summarize_tool_call — never model-written text, so a
// prompt-injected run cannot disguise what it is asking for.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{new_id, now_ts, DbResult};

/// Pending rows older than this are expired on every list (and at app start):
/// an approval that waits three days is stale, and honoring it is a hazard.
pub const APPROVAL_TTL_SECS: i64 = 72 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotApproval {
    pub id: String,
    pub bot_id: String,
    pub run_session_id: String,
    pub tool_name: String,
    pub args_json: String,
    pub summary: String,
    /// pending | approved | denied | expired | failed
    pub status: String,
    pub result: String,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    /// Joined from `bots` at read time so a rename never leaves a stale label.
    #[serde(default)]
    pub bot_name: String,
}

fn map_row(row: &rusqlite::Row) -> rusqlite::Result<BotApproval> {
    Ok(BotApproval {
        id: row.get("id")?,
        bot_id: row.get("bot_id")?,
        run_session_id: row.get("run_session_id")?,
        tool_name: row.get("tool_name")?,
        args_json: row.get("args_json")?,
        summary: row.get("summary")?,
        status: row.get("status")?,
        result: row.get("result")?,
        created_at: row.get("created_at")?,
        resolved_at: row.get("resolved_at")?,
        bot_name: row.get::<_, Option<String>>("bot_name")?.unwrap_or_default(),
    })
}

const SELECT_JOINED: &str = "SELECT a.*, COALESCE(b.name, '') AS bot_name \
     FROM bot_approvals a LEFT JOIN bots b ON b.id = a.bot_id";

/// Queue one write-class call for the owner. Returns the new row id.
pub fn insert_approval(
    conn: &Connection,
    bot_id: &str,
    run_session_id: &str,
    tool_name: &str,
    args_json: &str,
    summary: &str,
) -> DbResult<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO bot_approvals (id, bot_id, run_session_id, tool_name, args_json, summary, status, result, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', '', ?7)",
        params![id, bot_id, run_session_id, tool_name, args_json, summary, now_ts()],
    )?;
    Ok(id)
}

/// Pending rows for one bot, newest first (drives the gold rail dot + inbox).
pub fn list_pending_approvals(conn: &Connection, bot_id: &str) -> DbResult<Vec<BotApproval>> {
    expire_stale_approvals(conn)?;
    let mut stmt = conn.prepare(&format!(
        "{SELECT_JOINED} WHERE a.bot_id = ?1 AND a.status = 'pending' ORDER BY a.created_at DESC"
    ))?;
    let rows = stmt.query_map(params![bot_id], map_row)?;
    rows.collect()
}

/// Every bot's approvals (optionally filtered to one bot) for the desktop
/// inbox and the relay's phone screen.
pub fn list_approvals(conn: &Connection, bot_id: Option<&str>) -> DbResult<Vec<BotApproval>> {
    expire_stale_approvals(conn)?;
    match bot_id {
        Some(id) => {
            let mut stmt = conn.prepare(&format!(
                "{SELECT_JOINED} WHERE a.bot_id = ?1 ORDER BY a.created_at DESC LIMIT 200"
            ))?;
            let rows = stmt.query_map(params![id], map_row)?;
            rows.collect()
        }
        None => {
            let mut stmt = conn.prepare(&format!(
                "{SELECT_JOINED} ORDER BY a.status = 'pending' DESC, a.created_at DESC LIMIT 200"
            ))?;
            let rows = stmt.query_map([], map_row)?;
            rows.collect()
        }
    }
}

pub fn count_pending_approvals(conn: &Connection, bot_id: &str) -> DbResult<i64> {
    expire_stale_approvals(conn)?;
    conn.query_row(
        "SELECT COUNT(*) FROM bot_approvals WHERE bot_id = ?1 AND status = 'pending'",
        params![bot_id],
        |r| r.get(0),
    )
}

pub fn get_approval(conn: &Connection, id: &str) -> DbResult<Option<BotApproval>> {
    let mut stmt = conn.prepare(&format!("{SELECT_JOINED} WHERE a.id = ?1"))?;
    Ok(stmt.query_row(params![id], map_row).optional()?)
}

/// Write the outcome of a resolve (or the replay's failure) back onto the row.
pub fn resolve_approval_row(
    conn: &Connection,
    id: &str,
    status: &str,
    result: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE bot_approvals SET status = ?2, result = ?3, resolved_at = ?4 \
         WHERE id = ?1 AND status = 'pending'",
        params![id, status, result, now_ts()],
    )?;
    Ok(())
}

/// Atomically claim a still-pending approval for a terminal status, BEFORE the
/// tool is replayed. Returns `true` only for the caller that won the race.
///
/// This is the concurrency guard for `resolve_bot_approval`: the desktop inbox
/// and a paired phone can both fire an approve at the same moment, and the
/// reply side effect (a shell command, a download, a vault write) must run
/// exactly once. The conditional `status = 'pending'` makes the transition the
/// single point of serialization — a loser gets `false` and must not replay.
pub fn claim_pending_approval(conn: &Connection, id: &str, status: &str) -> DbResult<bool> {
    let n = conn.execute(
        "UPDATE bot_approvals SET status = ?2, resolved_at = ?3 \
         WHERE id = ?1 AND status = 'pending'",
        params![id, status, now_ts()],
    )?;
    Ok(n == 1)
}

/// Finish a claimed approval with the replay's outcome. Unlike
/// `resolve_approval_row` this does NOT require the row to still be `pending`
/// (the claim already moved it), so a failed replay can rewrite the claim to
/// `failed` with the error text.
pub fn set_approval_result(
    conn: &Connection,
    id: &str,
    status: &str,
    result: &str,
) -> DbResult<()> {
    conn.execute(
        "UPDATE bot_approvals SET status = ?2, result = ?3 WHERE id = ?1",
        params![id, status, result],
    )?;
    Ok(())
}

/// Pending → expired past the TTL. Cheap (indexed on bot_id, status), runs on
/// every list and at app start.
pub fn expire_stale_approvals(conn: &Connection) -> DbResult<usize> {
    let cutoff = now_ts() - APPROVAL_TTL_SECS;
    let n = conn.execute(
        "UPDATE bot_approvals SET status = 'expired', resolved_at = ?2 \
         WHERE status = 'pending' AND created_at < ?1",
        params![cutoff, now_ts()],
    )?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        super::super::mem()
    }

    fn bot(c: &Connection, name: &str) -> String {
        super::super::bots::create_bot(
            c,
            &super::super::BotInput {
                name: name.into(),
                description: None,
                emoji: None,
                color: None,
                pet: None,
                system_prompt: None,
                provider: None,
                model: None,
                tools_enabled: None,
                memory_enabled: None,
                enabled: None,
                inherit_global_prompt: None,
                memory_read_default: None,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn queue_list_resolve_roundtrip() {
        let c = conn();
        let b = bot(&c, "Atlas");
        let id = insert_approval(&c, &b, "run-1", "create_vault_note", "{\"title\":\"Standup\"}", "Create vault note \"Standup\"").unwrap();
        let pending = list_pending_approvals(&c, &b).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].summary, "Create vault note \"Standup\"");
        assert_eq!(pending[0].bot_name, "Atlas", "the list joins the CURRENT name");
        assert_eq!(count_pending_approvals(&c, &b).unwrap(), 1);
        resolve_approval_row(&c, &id, "approved", "created").unwrap();
        assert_eq!(count_pending_approvals(&c, &b).unwrap(), 0);
        let all = list_approvals(&c, Some(&b)).unwrap();
        assert_eq!(all[0].status, "approved");
        assert_eq!(all[0].result, "created");
    }

    #[test]
    fn resolved_rows_are_immutable() {
        let c = conn();
        let b = bot(&c, "Atlas");
        let id = insert_approval(&c, &b, "run-1", "t", "{}", "s").unwrap();
        resolve_approval_row(&c, &id, "denied", "nope").unwrap();
        resolve_approval_row(&c, &id, "approved", "late").unwrap();
        assert_eq!(get_approval(&c, &id).unwrap().unwrap().status, "denied");
    }

    #[test]
    fn stale_pending_rows_expire_and_cannot_be_approved() {
        let c = conn();
        let b = bot(&c, "Atlas");
        let id = insert_approval(&c, &b, "run-1", "t", "{}", "s").unwrap();
        c.execute(
            "UPDATE bot_approvals SET created_at = ?2 WHERE id = ?1",
            params![id, now_ts() - APPROVAL_TTL_SECS - 60],
        )
        .unwrap();
        assert_eq!(list_pending_approvals(&c, &b).unwrap().len(), 0);
        let row = get_approval(&c, &id).unwrap().unwrap();
        assert_eq!(row.status, "expired");
        resolve_approval_row(&c, &id, "approved", "late").unwrap();
        assert_eq!(get_approval(&c, &id).unwrap().unwrap().status, "expired");
    }

    #[test]
    fn claim_serializes_concurrent_resolves() {
        let c = conn();
        let b = bot(&c, "Atlas");
        let id = insert_approval(&c, &b, "run-1", "run_shell", "{}", "Run shell: ls").unwrap();
        // First resolve claims the row…
        assert!(claim_pending_approval(&c, &id, "approved").unwrap());
        // …and a racing second resolve (desktop + phone) loses and must not
        // replay or claim again.
        assert!(!claim_pending_approval(&c, &id, "denied").unwrap());
        let row = get_approval(&c, &id).unwrap().unwrap();
        assert_eq!(row.status, "approved");
        // A failed replay can rewrite the claim to `failed` after the fact.
        set_approval_result(&c, &id, "failed", "boom").unwrap();
        let row = get_approval(&c, &id).unwrap().unwrap();
        assert_eq!((row.status.as_str(), row.result.as_str()), ("failed", "boom"));
        // An already-resolved row is never claimable again.
        assert!(!claim_pending_approval(&c, &id, "approved").unwrap());
    }

    #[test]
    fn deleting_a_bot_deletes_its_approvals() {
        let c = conn();
        let b = bot(&c, "Atlas");
        insert_approval(&c, &b, "run-1", "t", "{}", "s").unwrap();
        super::super::bots::delete_bot(&c, &b, false).unwrap();
        assert_eq!(list_approvals(&c, None).unwrap().len(), 0);
    }
}
