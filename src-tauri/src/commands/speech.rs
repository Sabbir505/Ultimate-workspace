//! Voice input via a local whisper-compatible transcription server
//! (roadmap #16). The composer records audio (MediaRecorder → WAV/MP3), sends
//! the bytes to a whisper.cpp `whisper-server` (or any OpenAI Speech-to-Text
//! compatible endpoint) and returns the recognized text to insert back into
//! the composer.
//!
//! This mirrors the llama-server sidecar pattern: the endpoint is configurable
//! via `app_settings` (`whisper.baseUrl`), defaulting to the local whisper
//! server convention. It is deliberately provider-agnostic so a user can point
//! it at whisper-server, a cloud STT, or a bundler binary.

use base64::Engine;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Notify;

use crate::db;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// Cancellation slots for in-flight transcription requests, keyed by a short
/// client-chosen tag ("partial", "commit"). Dropping the reqwest future closes
/// the connection, and whisper.cpp's server aborts inference early when its
/// client disconnects — so a cancelled request stops burning the serial
/// inference queue almost immediately instead of running to completion and
/// delaying the requests that matter behind it.
static CANCEL_SLOTS: once_cell::sync::Lazy<parking_lot::Mutex<HashMap<String, Arc<Notify>>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(HashMap::new()));

fn register_cancel_slot(tag: &str) -> Arc<Notify> {
    let notify = Arc::new(Notify::new());
    CANCEL_SLOTS.lock().insert(tag.to_string(), notify.clone());
    notify
}

fn unregister_cancel_slot(tag: &str) {
    CANCEL_SLOTS.lock().remove(tag);
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    /// The base URL actually used (for diagnostics/UI).
    pub base_url: String,
}

/// Transcribe a recorded audio clip (base64 WAV/MP3 bytes) via a whisper
/// Server-Sent compatible endpoint. Returns the recognized text.
///
/// Endpoint resolution: the RUNNING whisper-server sidecar always wins — POST
/// to its `/inference` endpoint. If no sidecar is up, one is lazily started
/// from the installed binary+model (mic press self-heals; Settings → Local
/// Models → Speech manages both). Only when that's impossible do we fall back
/// to an explicitly-configured OpenAI-compatible `whisper.baseUrl` — never to
/// the guessed default port, which just produces confusing connection errors.
///
/// `tag` opts the request into cancellation: the client can abort it via
/// `transcribe_cancel` (used for stale live-partials and aborted commits —
/// the whisper server processes requests strictly serially, so letting a
/// stale request finish would delay everything queued behind it).
#[tauri::command]
pub async fn transcribe_audio(
    db: State<'_, DbState>,
    stt: State<'_, crate::commands::stt::SttState>,
    payload: String,
    mime: Option<String>,
    tag: Option<String>,
) -> CmdResult<TranscriptionResult> {
    use reqwest::multipart;

    // Sidecar first: it serves whisper.cpp's native /inference endpoint.
    let mut sidecar_base = crate::commands::stt::active_base_url(&stt);
    let mut setup_error: Option<String> = None;
    if sidecar_base.is_none() {
        // Lazy-start — best effort. On failure remember why so an unconfigured
        // setup reports "install it here" instead of a raw connection error.
        match crate::commands::stt::start_sidecar_core(&db, &stt).await {
            Ok(port) => sidecar_base = Some(format!("http://127.0.0.1:{port}")),
            Err(e) => setup_error = Some(e),
        }
    }
    let (base_url, endpoint_path) = match sidecar_base {
        Some(base) => (base, "/inference".to_string()),
        None => {
            let explicit = {
                let conn = db.0.lock();
                db::get_setting(&conn, "whisper.baseUrl")
                    .ok()
                    .flatten()
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty())
            };
            match explicit {
                Some(base) => (base, "/v1/audio/transcriptions".to_string()),
                // Nothing running, nothing installable/startable, and the user
                // never pointed at an external STT — say exactly what to do.
                None => {
                    return Err(setup_error.unwrap_or_else(|| {
                        "no speech-to-text server available — open Settings → Local Models → Speech"
                            .into()
                    }))
                }
            }
        }
    };
    let endpoint = format!("{}{}", base_url.trim_end_matches('/'), endpoint_path);

    // Decode the base64 audio payload.
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .map_err(|e| format!("could not decode audio payload: {e}"))?;

    // WebView2's MediaRecorder defaults to WebM/Opus on Windows; macOS Safari
    // produces mp4; Whisper.cpp / openai-whisper accept all three. Pick the
    // extension to match the actual container so the server decodes correctly
    // (sending a .webm body with mime "audio/wav" makes whisper fail silently).
    let (ext, part_mime) = match mime.as_deref() {
        Some("audio/wav" | "audio/wave" | "audio/x-wav") => ("wav", "audio/wav"),
        Some("audio/ogg") => ("ogg", "audio/ogg"),
        Some("audio/mp4" | "audio/mpeg") | Some("audio/mp3") => ("mp3", "audio/mpeg"),
        Some("audio/webm") | Some("video/webm") => ("webm", "audio/webm"),
        _ => ("wav", "audio/wav"),
    };
    let filename = format!("recording.{ext}");

    let part = multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(part_mime)
        .map_err(|e| e.to_string())?;
    let form = multipart::Form::new().part("file", part).text("model", "whisper-1");

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    // Tagged requests race the send against a cancel signal; winning the race
    // drops the reqwest future, closing the connection so the server aborts.
    let resp = if let Some(notify) = tag.as_deref().map(register_cancel_slot) {
        tokio::select! {
            r = client.post(&endpoint).multipart(form).send() => {
                r.map_err(|e| format!("whisper request failed: {e}"))?
            }
            _ = notify.notified() => {
                if let Some(t) = tag.as_deref() {
                    unregister_cancel_slot(t);
                }
                return Err("transcription cancelled by client".into());
            }
        }
    } else {
        client
            .post(&endpoint)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("whisper request failed: {e}"))?
    };
    if let Some(t) = tag.as_deref() {
        unregister_cancel_slot(t);
    }
    if !resp.status().is_success() {
        return Err(format!("whisper server returned HTTP {}: {}", resp.status(), resp.text().await.unwrap_or_default()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("bad whisper response: {e}"))?;
    let text = json["text"]
        .as_str()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if text.is_empty() {
        return Err("whisper returned no recognized text".to_string());
    }
    Ok(TranscriptionResult { text, base_url: base_url.clone() })
}

/// Abort an in-flight `transcribe_audio` request previously sent with `tag`.
/// No-op when that request already finished (its slot is removed on
/// completion), so a late cancel can never hit the wrong request.
#[tauri::command]
pub async fn transcribe_cancel(tag: String) -> CmdResult<()> {
    if let Some(notify) = CANCEL_SLOTS.lock().remove(&tag) {
        notify.notify_one();
    }
    Ok(())
}
