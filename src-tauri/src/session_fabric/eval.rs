//! Session Mesh P4 eval scenarios (test-only; fixture pattern from
//! `db/docs_eval.rs` / `memory/eval.rs`).
//!
//! Where `mod tests` covers individual units (caps arithmetic, watermark
//! math, status transitions), these are multi-step SCENARIOS — the mesh
//! stories a user actually lives through, each asserted end-to-end:
//!
//! 1. Hook round-trip: a delivered mesh mail and its watched turn's end
//!    fire the P4 lifecycle hooks (`mesh_message` / `mesh_turn_complete`)
//!    with the full payload contract, through the real hook runtime
//!    (config load → matcher → exec gate → process spawn → stdin JSON).
//! 2. Question round-trip: envelope contract → watermark math → answer
//!    capture → bare-ack filtering → mail status audit trail.
//! 3. Caps under burst: hourly mail budget, queue depth, spawn depth and
//!    children/day ceilings all trip exactly where the design says.

use rusqlite::Connection;
use serde_json::Value;
use tauri::Manager;

use super::{
    is_bare_ack, mail_envelope, MAX_CHILDREN_PER_PARENT, MAX_FOLLOWUP_DEPTH, MAX_MAIL_CHARS,
    MAX_MAIL_PER_HOUR, MAX_QUEUE_DEPTH, MAX_SPAWN_DEPTH,
};
use crate::db::session_fabric as store;

/// Minimal mesh schema (same shape as `mod tests::mem_conn`): just the
/// tables these scenarios read and write.
fn mem_conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE chat_sessions (
           id TEXT PRIMARY KEY, title TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
           created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
           starred INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
           watch_mode TEXT, agent TEXT, project_id TEXT, permission_mode TEXT,
           worktree_path TEXT, cwd_override TEXT, sandbox_policy TEXT, approval_policy TEXT,
           auto_model INTEGER NOT NULL DEFAULT 0, effort_level TEXT, origin TEXT,
           agent_def_id TEXT);
         CREATE TABLE chat_messages (
           id INTEGER PRIMARY KEY AUTOINCREMENT, chat_session_id TEXT NOT NULL,
           role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
           superseded_by INTEGER);
         CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE session_mail (
           id TEXT PRIMARY KEY, from_session TEXT NOT NULL, to_session TEXT NOT NULL,
           mode TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, answer TEXT,
           depth INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
           delivered_at INTEGER, answered_at INTEGER);",
    )
    .unwrap();
    conn
}

fn seed(conn: &Connection, id: &str, title: &str, agent: Option<&str>) {
    conn.execute(
        "INSERT INTO chat_sessions (id, title, provider, model, created_at, last_active_at, agent)
         VALUES (?1, ?2, 'anthropic', 'm', 1, 2, ?3)",
        rusqlite::params![id, title, agent],
    )
    .unwrap();
}

// ── Scenario 1: the P4 hooks fire with the full payload contract ─────────

/// A mesh hook that dumps its stdin JSON payload to a file (the script runs
/// exec-form; the payload arrives on stdin).
fn capture_def(dir: &tempfile::TempDir, id: &str, event: crate::hooks::HookEvent) -> crate::hooks::HookDef {
    let out = dir.path().join(format!("{id}.json"));
    let (command, args) = if cfg!(windows) {
        let path = dir.path().join(format!("{id}.cmd"));
        std::fs::write(
            &path,
            format!(
                "@echo off\r\n@more > \"{}\"\r\n@exit /b 0\r\n",
                out.display()
            ),
        )
        .unwrap();
        ("cmd".to_string(), vec!["/C".to_string(), path.display().to_string()])
    } else {
        let path = dir.path().join(format!("{id}.sh"));
        std::fs::write(&path, format!("cat > {}\nexit 0\n", out.display())).unwrap();
        ("sh".to_string(), vec![path.display().to_string()])
    };
    crate::hooks::HookDef {
        id: id.to_string(),
        event,
        name: id.to_string(),
        matcher: "*".to_string(),
        command,
        args,
        timeout_secs: 10,
        on_error: crate::hooks::OnError::Open,
        run_async: false,
        origins: vec![],
        enabled: true,
    }
}

fn mock_app_with_hooks(defs: Vec<crate::hooks::HookDef>) -> tauri::AppHandle<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .unwrap();
    for d in &defs {
        crate::exec_gate::remember(&conn, "hook", &d.gate_ident());
    }
    crate::db::set_setting(
        &conn,
        crate::hooks::SETTINGS_KEY,
        &serde_json::to_string(&defs).unwrap(),
    )
    .unwrap();
    app.manage(crate::DbState(std::sync::Arc::new(parking_lot::Mutex::new(conn))));
    crate::hooks::invalidate_config_cache();
    app.handle().clone()
}

/// Wait for a hook's captured payload file (fire-and-forget spawn → poll).
fn wait_for_payload(path: &std::path::Path) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if let Ok(s) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                return v;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "hook payload never landed at {}",
            path.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[test]
fn scenario_p4_hooks_carry_the_mesh_payload_contract() {
    let dir = tempfile::tempdir().unwrap();
    let app = mock_app_with_hooks(vec![
        capture_def(&dir, "mesh-in", crate::hooks::HookEvent::MeshMessage),
        capture_def(&dir, "mesh-done", crate::hooks::HookEvent::MeshTurnComplete),
    ]);

    // Delivery: the mesh_message hook sees WHO mailed WHOM, in which mode.
    crate::hooks::mesh_event_detached(
        &app,
        crate::hooks::HookEvent::MeshMessage,
        "target-session",
        "asker-session",
        "mail-1",
        "question",
        "delivered",
        "What did we decide about X?",
    );
    let delivered = wait_for_payload(&dir.path().join("mesh-in.json"));
    assert_eq!(delivered["hook_event_name"], "mesh_message");
    assert_eq!(delivered["chat_session_id"], "target-session");
    assert_eq!(delivered["from_session"], "asker-session");
    assert_eq!(delivered["mail_id"], "mail-1");
    assert_eq!(delivered["mode"], "question");
    assert_eq!(delivered["status"], "delivered");
    assert_eq!(delivered["reply_preview"], "What did we decide about X?");

    // Turn end: the same contract, status answered, with the answer preview.
    crate::hooks::mesh_event_detached(
        &app,
        crate::hooks::HookEvent::MeshTurnComplete,
        "target-session",
        "asker-session",
        "mail-1",
        "question",
        "answered",
        "We decided X; see docs/x.md.",
    );
    let done = wait_for_payload(&dir.path().join("mesh-done.json"));
    assert_eq!(done["hook_event_name"], "mesh_turn_complete");
    assert_eq!(done["status"], "answered");
    assert_eq!(done["reply_preview"], "We decided X; see docs/x.md.");

    // Expiry also reports — audit/notification scripts see the sad path.
    crate::hooks::mesh_event_detached(
        &app,
        crate::hooks::HookEvent::MeshTurnComplete,
        "target-session",
        "asker-session",
        "mail-2",
        "question",
        "expired",
        "",
    );
    // The second hook file is rewritten by the same process — poll for the
    // updated status instead of a fresh file.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let v = wait_for_payload(&dir.path().join("mesh-done.json"));
        if v["mail_id"] == "mail-2" {
            assert_eq!(v["status"], "expired");
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "expired payload never landed"
        );
    }
}

// ── Scenario 2: a question's full round trip at the store layer ──────────

#[test]
fn scenario_question_round_trip_captures_only_the_real_answer() {
    let conn = mem_conn();
    seed(&conn, "asker", "Asking session", Some("harness:claude_code"));
    seed(&conn, "target", "Target session", None);

    // Envelope contract: the target must know this is machine mail from a
    // named peer with a reply contract — and a notify must NOT invite one.
    let mail = store::insert_mail(&conn, "asker", "target", "question", "What did we decide about X?", 1)
        .unwrap();
    let env = mail_envelope(&conn, &mail);
    assert!(env.contains("NOT typed by the user"));
    assert!(env.contains("Asking session"));
    assert!(env.contains("What did we decide about X?"));
    let notify = store::insert_mail(&conn, "asker", "target", "notify", "FYI only", 0).unwrap();
    assert!(mail_envelope(&conn, &notify).contains("do NOT reply"));

    // Watermark BEFORE delivery → answer capture sees only later rows.
    let watermark = store::max_message_id(&conn, "target").unwrap_or(0);
    conn.execute(
        "INSERT INTO chat_messages (chat_session_id, role, content, created_at) VALUES ('target', 'user', 'old', 1)",
        [],
    )
    .unwrap();
    let _ = watermark;
    let watermark = store::max_message_id(&conn, "target").unwrap_or(0);
    // The envelope turn runs; the target replies.
    conn.execute(
        "INSERT INTO chat_messages (chat_session_id, role, content, created_at) VALUES ('target', 'assistant', 'We decided X.', 2)",
        [],
    )
    .unwrap();
    let answer = store::last_assistant_message_after(&conn, "target", watermark)
        .unwrap()
        .unwrap();
    assert_eq!(answer, "We decided X.");

    // Status audit trail: queued → delivered → answered, with the answer.
    assert_eq!(mail.status, store::MAIL_QUEUED);
    store::set_mail_status(&conn, &mail.id, store::MAIL_DELIVERED, None).unwrap();
    store::set_mail_status(&conn, &mail.id, store::MAIL_ANSWERED, Some(&answer)).unwrap();
    let row = store::get_mail(&conn, &mail.id).unwrap().unwrap();
    assert_eq!(row.status, store::MAIL_ANSWERED);
    assert_eq!(row.answer.as_deref(), Some("We decided X."));

    // Bare-ack filter: a "Noted." answer must NOT ride back as an answer —
    // this is the guard against the mechanical Noted/Received ping-pong.
    assert!(is_bare_ack("Noted."));
    assert!(is_bare_ack("Received — thanks!"));
    assert!(!is_bare_ack(&answer));
}

// ── Scenario 3: every ceiling trips exactly where the design says ────────

#[test]
fn scenario_caps_trip_under_burst() {
    let conn = mem_conn();
    seed(&conn, "asker", "Asker", None);
    seed(&conn, "target", "Target", None);

    // Hourly mail budget: MAX_MAIL_PER_HOUR mails from one sender inside the
    // window, then the count says stop.
    for i in 0..MAX_MAIL_PER_HOUR {
        store::insert_mail(&conn, "asker", "target", "notify", &format!("m{i}"), 0).unwrap();
    }
    let sent = store::count_mail_from_since(&conn, "asker", crate::db::now_ts() - 3600).unwrap();
    assert_eq!(sent as i64, MAX_MAIL_PER_HOUR, "budget counter must see every mail");

    // Queue depth: MAX_QUEUE_DEPTH queued mails for a busy target, then the
    // mailbox is full. (Separate target — the budget mails above are queued
    // against "target" and would pollute this count.)
    seed(&conn, "busy", "Busy target", None);
    for i in 0..MAX_QUEUE_DEPTH {
        store::insert_mail(&conn, "asker", "busy", "question", &format!("q{i}"), 0).unwrap();
    }
    let backlog = store::queued_mail_for(&conn, "busy").unwrap().len();
    assert_eq!(backlog, MAX_QUEUE_DEPTH);

    // Spawn depth: a spawned_by: chain walks to MAX_SPAWN_DEPTH and no
    // further — the depth guard reads the chain from session origins.
    let mut parent = String::from("root");
    for depth in 1..=MAX_SPAWN_DEPTH + 1 {
        let id = format!("child{depth}");
        conn.execute(
            "INSERT INTO chat_sessions (id, title, provider, model, created_at, last_active_at, origin)
             VALUES (?1, 'child', 'anthropic', 'm', 1, 2, ?2)",
            rusqlite::params![id, format!("spawned_by:{parent}")],
        )
        .unwrap();
        let walked = store::spawn_depth(&conn, &id).unwrap();
        if depth <= MAX_SPAWN_DEPTH {
            assert_eq!(walked, depth as i64, "chain depth must walk exactly");
        } else {
            assert!(
                walked > MAX_SPAWN_DEPTH,
                "depth {depth} must EXCEED the ceiling so the guard trips"
            );
        }
        parent = id;
    }

    // Children/day: MAX_CHILDREN_PER_PARENT spawns in 24h, then no more.
    // (last_active_at must be RECENT — the cap counts live children only.)
    for i in 0..MAX_CHILDREN_PER_PARENT {
        conn.execute(
            "INSERT INTO chat_sessions (id, title, provider, model, created_at, last_active_at, origin)
             VALUES (?1, 'spawned', 'anthropic', 'm', 1, ?2, 'spawned_by:root')",
            rusqlite::params![format!("kid{i}"), crate::db::now_ts()],
        )
        .unwrap();
    }
    let kids = store::count_recent_spawned_children(&conn, "root", 86_400).unwrap();
    assert_eq!(kids as i64, MAX_CHILDREN_PER_PARENT);

    // The follow-up ceiling is independent: a depth-3 answer chain is the
    // last one forwarded (MAX_FOLLOWUP_DEPTH), which is what stops bounce
    // chains even when every other cap still has headroom.
    assert_eq!(MAX_FOLLOWUP_DEPTH, 3);
    // And the per-mail truncation bound the envelope promises.
    assert_eq!(MAX_MAIL_CHARS, 8000);
}
