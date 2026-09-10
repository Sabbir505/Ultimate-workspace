//! Shared resumable-download body pump. Both download engines (the model
//! tool's `download_task` in chat/tasks.rs and the Hugging Face market's
//! `run_download` in commands/local_model_market.rs) stream a response body
//! into a `.part` file with cancel + data-stall watchdogs; this module owns
//! that loop. Retry policies, auth handling, hashing/verification, progress
//! event shapes, and resume-identity checks stay with the callers — they
//! genuinely differ.

use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

/// Outcome of pumping one response body into the partial file. The byte
/// total written (prefix included) rides along for resume bookkeeping.
pub(crate) enum BodyPumpOutcome {
    /// Clean EOF — the whole body was written and flushed.
    Completed,
    /// The caller's cancel channel fired. The partial file is left on disk
    /// (closed, not removed) — resume/removal is the caller's policy.
    Cancelled,
    /// No data arrived within the stall timeout. Partial kept for resume.
    Stalled,
    /// The body stream errored mid-flight. Partial kept for resume.
    ReadError(String),
    /// A write or caller-callback failure. Partial kept; typically fatal.
    WriteError(String),
}

/// Stream `resp`'s body into `partial_path`, starting at `start` bytes:
/// append when `resuming` (server answered the Range request), truncate
/// otherwise. Per non-empty chunk the bytes are written to disk, then
/// `on_chunk(bytes, downloaded_total, total)` runs — an Err there aborts
/// with [`BodyPumpOutcome::WriteError`]. A data stall and the cancel
/// channel both stop the pump (biased select). Returns the outcome and the
/// cumulative downloaded byte count.
pub(crate) async fn pump_body_to_file(
    resp: reqwest::Response,
    partial_path: &Path,
    start: u64,
    resuming: bool,
    stall: Duration,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
    on_chunk: &mut (dyn FnMut(&[u8], u64, Option<u64>) -> Result<(), String> + Send),
) -> (BodyPumpOutcome, u64) {
    let opened = if resuming {
        let mut opts = tokio::fs::OpenOptions::new();
        opts.append(true).open(partial_path).await
    } else {
        tokio::fs::File::create(partial_path).await
    };
    let mut file = match opened {
        Ok(f) => f,
        Err(e) => {
            return (
                BodyPumpOutcome::WriteError(format!("could not open partial file: {e}")),
                start,
            )
        }
    };

    let total = if resuming {
        resp.content_length().map(|c| c + start)
    } else {
        resp.content_length()
    };
    let mut downloaded: u64 = start;
    let mut stream = resp.bytes_stream();

    loop {
        // Body-stall watchdog: headers can succeed and then the peer goes
        // quiet (dropped connection, hung proxy). Without this the stream
        // future parks forever. Biased so cancel wins a tied race.
        let stall = tokio::time::sleep(stall);
        tokio::pin!(stall);
        tokio::select! {
            biased;
            _ = &mut *cancel_rx => {
                // Caller drops or keeps the partial per its own policy; the
                // file is closed by leaving this scope.
                return (BodyPumpOutcome::Cancelled, downloaded);
            }
            _ = &mut stall => {
                return (BodyPumpOutcome::Stalled, downloaded);
            }
            next = stream.next() => {
                let Some(chunk) = next else { break };
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => return (BodyPumpOutcome::ReadError(format!("stream error: {e}")), downloaded),
                };
                if chunk.is_empty() { continue; }
                if let Err(e) = file.write_all(&chunk).await {
                    return (BodyPumpOutcome::WriteError(format!("write error: {e}")), downloaded);
                }
                downloaded = downloaded.saturating_add(chunk.len() as u64);
                if let Err(e) = on_chunk(&chunk, downloaded, total) {
                    return (BodyPumpOutcome::WriteError(e), downloaded);
                }
            }
        }
    }

    if let Err(e) = file.flush().await {
        return (BodyPumpOutcome::WriteError(format!("flush: {e}")), downloaded);
    }
    (BodyPumpOutcome::Completed, downloaded)
}
