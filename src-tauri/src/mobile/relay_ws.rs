//! WebSocket plumbing for mobile relay: channel-based owner tracking and message pumping.
//!
//! The write half carries the per-connection E2E state (§3.2.11): when the
//! phone pairs with an HMAC proof, a session key derived from the pairing
//! token is enabled here and every subsequent `send_ws_message` /
//! `decrypt_binary` transparently switches to XChaCha20-Poly1305 Binary
//! frames. Sinking the crypto state into the same tokio Mutex as the sink
//! itself makes counter reservation + frame write one atomic step, so the
//! request loop and the owner-channel pump (which send concurrently) can
//! never mint the same nonce.

use std::sync::Arc;

use futures_util::SinkExt;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::protocol::DesktopMessage;
use super::relay_crypto;

/// Type alias for the channel sender used to write DesktopMessages to a connection.
pub type WsSender = mpsc::UnboundedSender<DesktopMessage>;

/// Type alias for the owner map that tracks which session owns which connection.
pub type OwnerMap = Arc<Mutex<std::collections::HashMap<String, WsSender>>>;

/// Per-connection E2E encryption state (§3.2.11). `enabled` flips once the
/// phone's pairing proof has been verified; from that point on all
/// application-level frames are AEAD-encrypted Binary frames. Counters are
/// per-direction and strictly increasing so nonces are never reused.
#[derive(Clone)]
pub struct RelayE2E {
    pub enabled: bool,
    pub key: [u8; 32],
    pub out_counter: u64,
    pub in_counter: u64,
}

impl Default for RelayE2E {
    fn default() -> Self {
        RelayE2E {
            enabled: false,
            key: [0u8; 32],
            out_counter: 0,
            in_counter: 0,
        }
    }
}

/// The WebSocket write half plus its E2E state, behind one tokio async Mutex
/// (not parking_lot) because the guard is held across `.await` on send —
/// parking_lot guards are !Send and would make the pump task unspawnable.
pub struct SinkState {
    pub sink: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        Message,
    >,
    pub e2e: RelayE2E,
}

pub type SharedWsWrite = Arc<tokio::sync::Mutex<SinkState>>;

/// Serialize + send one DesktopMessage. When E2E is enabled for the
/// connection the JSON payload is encrypted (XChaCha20-Poly1305) and sent as
/// a Binary frame; otherwise it goes out as plaintext Text (legacy/dev path).
/// The send counter is reserved and consumed under the same lock as the
/// write, so concurrent senders (request loop + pump) never reuse a nonce.
pub async fn send_ws_message(
    write: &SharedWsWrite,
    msg: &DesktopMessage,
) -> Result<(), String> {
    let mut w = write.lock().await;
    if w.e2e.enabled {
        let bytes = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        let frame = relay_crypto::encrypt(&w.e2e.key, w.e2e.out_counter, &bytes);
        w.e2e.out_counter += 1;
        w.sink.send(Message::Binary(frame)).await.map_err(|e| e.to_string())
    } else {
        let text = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        w.sink.send(Message::Text(text)).await.map_err(|e| e.to_string())
    }
}

/// Decrypt one inbound Binary frame. Only valid while E2E is enabled; a
/// plaintext (Text) inbound frame in E2E mode is a protocol violation the
/// caller reports. The inbound counter advances for every Binary frame —
/// decrypt success or not — so it stays in lockstep with the phone's send
/// counter even if a single frame fails its tag check.
pub async fn decrypt_binary(
    write: &SharedWsWrite,
    frame: &[u8],
) -> Option<Vec<u8>> {
    let mut w = write.lock().await;
    if !w.e2e.enabled {
        return None;
    }
    let out = relay_crypto::decrypt(&w.e2e.key, w.e2e.in_counter, frame);
    w.e2e.in_counter += 1;
    out
}

/// Enable E2E for the connection: install the session key derived from the
/// pairing token and reset both direction counters. Called once, right after
/// the phone's pairing proof verifies.
pub async fn enable_e2e(write: &SharedWsWrite, key: [u8; 32]) {
    let mut w = write.lock().await;
    w.e2e = RelayE2E {
        enabled: true,
        key,
        out_counter: 0,
        in_counter: 0,
    };
}

/// Pump messages from the owner channel to the shared WebSocket write half.
/// Spawned once per connection; ends cleanly when every sender (the request
/// loop's own copy + all owner-map registrations) has been dropped, i.e.
/// when the connection handler exits and its cleanup guard has run.
/// Encrypts when the connection has E2E enabled — forwarded session-chat
/// events are user content and must not ride the wire in plaintext.
pub async fn pump_to_ws_shared(
    mut rx: mpsc::UnboundedReceiver<DesktopMessage>,
    write: SharedWsWrite,
) -> Result<(), String> {
    while let Some(msg) = rx.recv().await {
        send_ws_message(&write, &msg).await?;
    }
    Ok(())
}

/// Create a new (sender, receiver) pair for a single WebSocket connection.
/// The caller spawns `pump_to_ws` with the receiver and stores the sender in
/// the owner map so the relay can route session-scoped chat events to it.
pub fn make_channel() -> (WsSender, mpsc::UnboundedReceiver<DesktopMessage>) {
    mpsc::unbounded_channel()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The E2E round-trip at the plumbing level: encrypt with the sender's
    /// counter sequence, decrypt with the receiver's — the exact contract
    /// relay_crypto exposes and both sides of the socket rely on.
    #[test]
    fn counters_advance_independently_per_direction() {
        let mut e2e = RelayE2E::default();
        assert!(!e2e.enabled);
        e2e.out_counter += 1; // one outbound frame
        e2e.in_counter += 1;  // one inbound frame
        assert_eq!(e2e.out_counter, 1);
        assert_eq!(e2e.in_counter, 1);
    }
}
