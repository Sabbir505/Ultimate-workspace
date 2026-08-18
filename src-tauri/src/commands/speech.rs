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
use tauri::State;

use crate::db;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// Default local whisper-server base URL (whisper.cpp `whisper-server`).
const DEFAULT_WHISPER_URL: &str = "http://127.0.0.1:8081";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    /// The base URL actually used (for diagnostics/UI).
    pub base_url: String,
}

/// Transcribe a recorded audio clip (base64 WAV/MP3 bytes) via a whisper
/// Server-Sent compatible endpoint. Returns the recognized text.
#[tauri::command]
pub async fn transcribe_audio(
    db: State<'_, DbState>,
    payload: String,
    mime: Option<String>,
) -> CmdResult<TranscriptionResult> {
    use reqwest::multipart;

    let base_url = {
        let conn = db.0.lock();
        match db::get_setting(&conn, "whisper.baseUrl") {
            Ok(Some(u)) if !u.trim().is_empty() => u.trim().to_string(),
            _ => DEFAULT_WHISPER_URL.to_string(),
        }
    };
    let endpoint = format!("{}/v1/audio/transcriptions", base_url.trim_end_matches('/'));

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
    let resp = client
        .post(&endpoint)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("whisper request failed: {e}"))?;
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
