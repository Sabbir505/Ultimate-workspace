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

/// Pump messages from the channel to the WebSocket write half.
/// Runs as a separate task spawned per connection.
#[allow(dead_code)] // Wired into the per-connection pump in Task 6.
pub async fn pump_to_ws(
    mut rx: mpsc::UnboundedReceiver<DesktopMessage>,
    mut write: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        Message,
    >,
) -> Result<(), String> {
    while let Some(msg) = rx.recv().await {
        let text = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        if let Err(e) = write.send(Message::Text(text)).await {
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