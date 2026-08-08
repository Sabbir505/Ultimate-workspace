//! WebSocket plumbing for mobile relay: channel-based owner tracking and message pumping.

use std::sync::Arc;

use futures_util::SinkExt;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::protocol::DesktopMessage;

/// Type alias for the channel sender used to write DesktopMessages to a connection.
pub type WsSender = mpsc::UnboundedSender<DesktopMessage>;

/// Type alias for the owner map that tracks which session owns which connection.
pub type OwnerMap = Arc<Mutex<std::collections::HashMap<String, WsSender>>>;

/// The WebSocket write half shared between the connection's request loop and
/// its owner-channel pump. tokio's async Mutex (not parking_lot) because the
/// guard is held across `.await` on send — parking_lot guards are !Send and
/// would make the pump task unspawnable.
pub type SharedWsWrite = Arc<tokio::sync::Mutex<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    Message,
>>>;

/// Pump messages from the owner channel to the shared WebSocket write half.
/// Spawned once per connection; ends cleanly when every sender (the request
/// loop's own copy + all owner-map registrations) has been dropped, i.e.
/// when the connection handler exits and its cleanup guard has run.
pub async fn pump_to_ws_shared(
    mut rx: mpsc::UnboundedReceiver<DesktopMessage>,
    write: SharedWsWrite,
) -> Result<(), String> {
    while let Some(msg) = rx.recv().await {
        let text = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        let mut w = write.lock().await;
        if let Err(e) = w.send(Message::Text(text)).await {
            return Err(format!("failed to write to ws: {e}"));
        }
    }
    Ok(())
}

/// Create a new (sender, receiver) pair for a single WebSocket connection.
/// The caller spawns `pump_to_ws` with the receiver and stores the sender in
/// the owner map so the relay can route session-scoped chat events to it.
pub fn make_channel() -> (WsSender, mpsc::UnboundedReceiver<DesktopMessage>) {
    mpsc::unbounded_channel()
}