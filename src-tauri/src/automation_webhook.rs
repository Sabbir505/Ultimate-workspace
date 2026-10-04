//! Inbound webhook trigger listener for automations (see
//! TRIGGERS_RAG_PRICING_CATALOG_RESEARCH.md Part A(a)).
//!
//! One loopback HTTP server on 127.0.0.1 with an OS-assigned ephemeral port
//! (templated on browser_mcp::serve): `GET|POST /trigger/<automation_id>/<secret>`
//! fires the automation via the same launch path the cron tick uses
//! (`launch_run(source=Webhook)`), guarded by the same overlap guards.
//!
//! **Auth is mandatory**: an unauthenticated webhook that launches a
//! full-auto agent turn is remote code execution. The per-automation secret
//! (32 url-safe chars, generated at create time — see
//! automation_triggers::settle_webhook_secret) is compared in constant time.
//!
//! **App-open only by design.** The listener is loopback-bound and lives
//! exactly as long as the app; running webhooks while Relay is closed needs
//! an external tunnel, which is deliberately NOT auto-exposed. The bound
//! port is published in the `automations.triggerPort` setting (and logged at
//! startup); `automation_webhook_info` builds the full trigger URL for the
//! UI. (`automations.webhookUrl` is the OUTBOUND notify setting — unrelated.)

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::automation_triggers::{secret_for, secret_matches, TRIGGER_WEBHOOK};
use crate::automations::{launch_run, RunSource};
use crate::db::{self, Automation};

/// Port the listener actually bound (0 until `serve` runs).
static BOUND_PORT: AtomicU16 = AtomicU16::new(0);

/// The live trigger port; 0 when the listener isn't running (bind failure or
/// read before setup completes).
pub fn bound_port() -> u16 {
    BOUND_PORT.load(Ordering::SeqCst)
}

/// Settings key carrying the bound port as text — the UI/IPC getter reads
/// the in-process `bound_port()`; the setting exists so external tooling
/// (scripts curl-ing triggers) can discover the endpoint. Port discovery
/// only — never an auth grant.
pub const TRIGGER_PORT_SETTING: &str = "automations.triggerPort";

/// Tracked JoinHandle so app exit can abort the accept loop instead of
/// leaving it to runtime teardown — same pattern as BrowserMcpHandle (mi20).
pub struct WebhookServerHandle(pub Mutex<Option<tauri::async_runtime::JoinHandle<()>>>);

/// Bind 127.0.0.1:0 and serve trigger requests until the app exits. Bind
/// failure is non-fatal (webhook triggers just don't answer; everything else
/// in the app is unaffected).
pub async fn serve(app: AppHandle, db: Arc<Mutex<Connection>>) {
    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            crate::relay_eprintln!("[relay:automation-webhook] FAILED to bind 127.0.0.1:0: {e} — webhook triggers are unavailable");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    BOUND_PORT.store(port, Ordering::SeqCst);
    {
        let conn = db.lock();
        let _ = db::set_setting(&conn, TRIGGER_PORT_SETTING, &port.to_string());
    }
    crate::relay_eprintln!(
        "[relay:automation-webhook] trigger listener on http://127.0.0.1:{port}/trigger/<id>/<secret> (app-open only)"
    );

    loop {
        match listener.accept().await {
            Ok((stream, _peer)) => {
                let app = app.clone();
                let db = Arc::clone(&db);
                tokio::spawn(async move {
                    handle_connection(stream, app, db).await;
                });
            }
            Err(e) => {
                crate::relay_eprintln!("[relay:automation-webhook] accept error: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

/// The full local trigger URL for one automation — the dedicated getter the
/// UI (and the chat tool's create reply) use, since list/get responses have
/// the secret redacted.
pub fn trigger_url(db: &Arc<Mutex<Connection>>, automation: &Automation) -> Result<String, String> {
    let port = bound_port();
    if port == 0 {
        return Err("webhook trigger listener is not running".into());
    }
    let secret = secret_for(automation)
        .ok_or_else(|| "automation has no webhook secret (not a webhook trigger)".to_string())?;
    Ok(format!(
        "http://127.0.0.1:{port}/trigger/{}/{}",
        automation.id, secret
    ))
}

async fn handle_connection(mut stream: TcpStream, app: AppHandle, db: Arc<Mutex<Connection>>) {
    // Pre-auth budget: headers (and so the whole request line) must arrive
    // within 5s and 8 KiB, or the connection is dropped — an unauthenticated
    // peer can't hold a socket open indefinitely.
    let request_line = match read_request_line(&mut stream).await {
        Some(line) => line,
        None => return,
    };
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" && method != "POST" {
        respond(&mut stream, 405, "Method Not Allowed", r#"{"ok":false,"error":"method_not_allowed"}"#).await;
        return;
    }
    let path = target.split('?').next().unwrap_or("");
    let Some((automation_id, secret)) = parse_trigger_path(path) else {
        respond(&mut stream, 404, "Not Found", r#"{"ok":false,"error":"not_found"}"#).await;
        return;
    };

    let automation: Option<Automation> = {
        let conn = db.lock();
        db::get_automation(&conn, &automation_id).ok().flatten()
    };
    // Unknown id, disabled row, or a row that isn't a webhook trigger all
    // read as not-found (no state disclosure).
    let automation = automation.filter(|a| a.enabled && a.trigger_type == TRIGGER_WEBHOOK);
    let Some(automation) = automation else {
        respond(&mut stream, 404, "Not Found", r#"{"ok":false,"error":"not_found"}"#).await;
        return;
    };
    let Some(expected) = secret_for(&automation) else {
        respond(&mut stream, 404, "Not Found", r#"{"ok":false,"error":"not_found"}"#).await;
        return;
    };
    if !secret_matches(&expected, &secret) {
        respond(&mut stream, 403, "Forbidden", r#"{"ok":false,"error":"forbidden"}"#).await;
        return;
    }
    // launch_run itself overlap-guards (records "skipped"), but answer 409
    // up front so the caller learns the run did NOT start.
    if crate::automations::is_running(&automation.id) {
        respond(&mut stream, 409, "Conflict", r#"{"ok":false,"error":"already_running"}"#).await;
        return;
    }
    match launch_run(Some(&app), &db, &automation, RunSource::Webhook) {
        Ok(()) => respond(&mut stream, 200, "OK", r#"{"ok":true}"#).await,
        Err(e) => {
            crate::relay_eprintln!("[relay:automation-webhook] launch failed for {}: {e}", automation.id);
            respond(
                &mut stream,
                500,
                "Internal Server Error",
                r#"{"ok":false,"error":"launch_failed"}"#,
            )
            .await;
        }
    }
}

/// `/trigger/<automation_id>/<secret>` → (id, secret). Anything else is None.
fn parse_trigger_path(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("/trigger/")?;
    let (id, secret) = rest.split_once('/')?;
    if id.is_empty() || secret.is_empty() {
        return None;
    }
    Some((id.to_string(), secret.to_string()))
}

/// Read up to the end of the request headers (or the 8 KiB cap — the request
/// line is all we need) with a 5s bound. Returns the FIRST line.
async fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    let mut buf = [0u8; 1024];
    let mut got: Vec<u8> = Vec::with_capacity(1024);
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf))
            .await
            .ok()?
            .ok()?;
        if n == 0 {
            return None;
        }
        got.extend_from_slice(&buf[..n]);
        if got.windows(4).any(|w| w == b"\r\n\r\n") || got.len() > 8 * 1024 {
            break;
        }
    }
    let head = String::from_utf8_lossy(&got);
    head.lines().next().map(str::to_string)
}

async fn respond(stream: &mut TcpStream, status: u16, reason: &str, body: &str) {
    let http = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(http.as_bytes()).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_path_parses_id_and_secret() {
        assert_eq!(
            parse_trigger_path("/trigger/abc/S3CRET"),
            Some(("abc".into(), "S3CRET".into()))
        );
        // Query strings are stripped by the caller, but don't break parsing.
        assert_eq!(
            parse_trigger_path("/trigger/abc/S3C?x=1"),
            Some(("abc".into(), "S3C?x=1".into()))
        );
        assert_eq!(parse_trigger_path("/trigger/abc"), None);
        assert_eq!(parse_trigger_path("/trigger//secret"), None);
        assert_eq!(parse_trigger_path("/trigger/abc/"), None);
        assert_eq!(parse_trigger_path("/other/abc/secret"), None);
    }
}
