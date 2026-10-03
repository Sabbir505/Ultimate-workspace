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
//!
//! Both counters track frames the peer ACTUALLY minted: the send side advances
//! only on a real write and the receive side only on a successful decrypt, so
//! an injected/undecryptable frame can never burn a counter slot and wedge the
//! rest of the session.

use std::sync::Arc;

use futures_util::SinkExt;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::protocol::DesktopMessage;
use super::relay_crypto;

/// Type alias for the channel sender used to write DesktopMessages to a connection.
/// BOUNDED (audit L-12): the per-connection channel used to be unbounded, so
/// a half-open/stalled phone socket (pump stuck on the shared write lock)
/// buffered every streamed token for as long as the stall lasted — memory
/// growth proportional to traffic. Producers use `try_send` and DROP when
/// full; a stalled connection loses live events (the transcript stays
/// readable via read_session) instead of growing without bound.
pub type WsSender = mpsc::Sender<DesktopMessage>;

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
/// caller reports.
///
/// The inbound counter advances ONLY on a successful decryption, because it
/// must track frames the PEER actually minted and no more: the phone mints
/// frame N at `out_counter = N` and only advances on a real write, so a frame
/// we fail to decrypt was never a frame the phone sent at this position.
/// Advancing anyway let an on-path attacker who appended ONE garbage frame
/// desync the sequence permanently — toward the phone there is no re-key, so
/// the session stayed `connected: true` and silently received nothing again;
/// toward the desktop, five injected frames tripped the H43 eviction and
/// killed the REAL phone's session.
///
/// The converse risk — a buggy/old peer that increments anyway — is a
/// persistent desync by construction (every one of its frames fails from then
/// on), which surfaces as H43's consecutive-failure eviction and a reconnect
/// under a fresh salt. A silent wedge is the worse outcome, so holding the
/// counter wins.
pub async fn decrypt_binary(
    write: &SharedWsWrite,
    frame: &[u8],
) -> Option<Vec<u8>> {
    let mut w = write.lock().await;
    if !w.e2e.enabled {
        return None;
    }
    let out = relay_crypto::decrypt(&w.e2e.key, w.e2e.in_counter, frame);
    if out.is_some() {
        w.e2e.in_counter += 1;
    }
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
    mut rx: mpsc::Receiver<DesktopMessage>,
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
pub fn make_channel() -> (WsSender, mpsc::Receiver<DesktopMessage>) {
    mpsc::channel(2048)
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

    /// The counter-decision this module owns, without the socket: a frame that
    /// fails its tag check must NOT consume a counter slot. Advancing anyway
    /// let one on-path-injected garbage frame desync the session permanently.
    #[test]
    fn in_counter_only_advances_on_a_successful_decrypt() {
        let key = [9u8; 32];
        let mut e2e = RelayE2E {
            enabled: true,
            key,
            out_counter: 0,
            in_counter: 0,
        };
        // The peer's first genuine frame.
        let good = relay_crypto::encrypt(&key, 0, b"hello");
        assert!(relay_crypto::decrypt(&e2e.key, e2e.in_counter, &good).is_some());
        e2e.in_counter += 1;
        assert_eq!(e2e.in_counter, 1);

        // An injected garbage frame at the same nonce — a frame the peer never
        // minted, so its out_counter did not advance either.
        let mut junk = good.clone();
        junk[30] ^= 0xFF;
        assert!(relay_crypto::decrypt(&e2e.key, e2e.in_counter, &junk).is_none());
        // The invariant `decrypt_binary` now implements: no advance on failure.
        assert_eq!(
            e2e.in_counter, 1,
            "a failed decrypt must not burn the next counter slot"
        );

        // ...so the peer's NEXT genuine frame still lands.
        let next = relay_crypto::encrypt(&key, 1, b"still here");
        assert_eq!(
            relay_crypto::decrypt(&e2e.key, e2e.in_counter, &next).as_deref(),
            Some(b"still here".as_slice()),
            "one injected frame must not wedge the rest of the session"
        );
    }
}

// bounce
