//! E2E encryption for the mobile ↔ desktop relay channel (§3.2.11).
//!
//! **Design:** the 256-bit pairing token is a genuine pre-shared secret (it
//! travels out-of-band in the pairing URL/QR fragment and is NEVER sent over the
//! wire). Both sides derive a 32-byte XChaCha20 session key from it via
//! HKDF-SHA256. The phone proves token possession with
//! `Hex(HMAC-SHA256(token, "E2E"))` in the Pair frame instead of sending the raw
//! token, and every post-pair frame is then AEAD-encrypted with
//! XChaCha20-Poly1305 (24-byte nonce, 16-byte tag).
//!
//! - **No pubkey exchange needed** — the token is a genuine PSK.
//! - **No plaintext token on the wire** — a passive LAN observer cannot derive
//!   the key, which is what makes this actual E2E (not just token gating).
//! - **Nonce discipline:** nonces come from a per-direction strictly increasing
//!   counter (16 zero bytes + 8-byte big-endian counter), so they are never
//!   reused within a session.
//! - **Forward secrecy:** not provided across relay restarts (token rotates on
//!   restart); acceptable for the §3.2.11 threat model (passive LAN observer).

use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, aead::Aead,
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

const HKDF_INFO: &[u8] = b"conduit-e2e-relay-v1";
const HKDF_SALT: &[u8] = b"conduit-e2e-relay-salt-v1";

/// Derive a 32-byte XChaCha20 session key from a 256-bit (43-char base64url) token.
pub fn derive_session_key(token: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), token.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm).expect("HKDF 32-byte output");
    okm
}

/// Compute the pairing proof: HMAC-SHA256(key=token, data="E2E").
/// Returns the proof as lowercase-hex (the wire format both sides use).
pub fn compute_pair_proof(token: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(token.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(b"E2E");
    let out = mac.finalize().into_bytes();
    out.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Verify a phone-presented pairing proof in constant time against the
/// desktop's own derived proof for the expected token.
pub fn verify_pair_proof(expected_token: &str, presented: &str) -> bool {
    let ours = compute_pair_proof(expected_token);
    // Constant-time compare via subtle.
    ours.as_bytes().ct_eq(presented.as_bytes()).into()
}

/// Build a 24-byte nonce from a per-direction counter: 16 zero bytes + the
/// counter as big-endian u64. Matches the mobile-side layout exactly.
fn counter_nonce(counter: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[16..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

/// Encrypt `plaintext` with the session key + `send_counter`.
/// Output format: `[24-byte nonce][ciphertext][16-byte tag]`.
pub fn encrypt(key: &[u8; 32], counter: u64, plaintext: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .expect("32-byte key is the valid XChaCha20 key size");
    let nonce = counter_nonce(counter);
    let ct = cipher
        .encrypt(&nonce.into(), plaintext)
        .expect("XChaCha20-Poly1305 encryption with valid key/nonce never fails");
    let mut out = Vec::with_capacity(24 + ct.len());
    out.extend_from_slice(&nonce);
    out.extend(ct);
    out
}

/// Decrypt a frame produced by `encrypt`. Returns `None` on wrong key or
/// tampering (the tag will not verify).
pub fn decrypt(key: &[u8; 32], counter: u64, frame: &[u8]) -> Option<Vec<u8>> {
    if frame.len() < 24 + 16 {
        return None;
    }
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .expect("32-byte key is the valid XChaCha20 key size");
    let nonce = &frame[..24];
    // The claimed nonce must equal the expected counter nonce — otherwise it's
    // a replayed/interleaved frame from another session.
    if nonce != counter_nonce(counter) {
        return None;
    }
    cipher.decrypt(nonce.into(), &frame[24..]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_key_is_stable_and_distinct() {
        let k1 = derive_session_key("token-one-0000000000000000000000");
        let k2 = derive_session_key("token-one-0000000000000000000000");
        assert_eq!(k1, k2);
        let k3 = derive_session_key("token-two-0000000000000000000000");
        assert_ne!(k1, k3);
        assert_eq!(k1.len(), 32);
    }

    #[test]
    fn proof_roundtrip_and_wrong_token() {
        let token = "correct-token-000000000000000000000000";
        let proof = compute_pair_proof(token);
        assert!(verify_pair_proof(token, &proof));
        assert!(!verify_pair_proof("wrong-token-00000000000000000000000", &proof));
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = derive_session_key("roundtrip-token-000000000000000000");
        let pt = b"hello encrypted relay";
        let frame = encrypt(&key, 0, pt);
        assert!(frame.len() > 24 + pt.len());
        let out = decrypt(&key, 0, &frame).expect("decrypt");
        assert_eq!(out, pt);
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let key1 = derive_session_key("key-one-token-00000000000000000000");
        let key2 = derive_session_key("key-two-token-00000000000000000000");
        let frame = encrypt(&key1, 0, b"secret");
        assert!(decrypt(&key2, 0, &frame).is_none());
    }

    #[test]
    fn counter_nonce_is_checked_on_decrypt() {
        let key = derive_session_key("counter-token-00000000000000000000");
        let frame = encrypt(&key, 3, b"payload");
        // A frame encrypted at counter 3 cannot be decrypted at a different counter.
        assert!(decrypt(&key, 2, &frame).is_none());
        assert!(decrypt(&key, 4, &frame).is_none());
        assert_eq!(decrypt(&key, 3, &frame).unwrap(), b"payload");
    }

    #[test]
    fn encrypt_does_not_reuse_nonce_across_counters() {
        let key = derive_session_key("nonce-token-0000000000000000000000");
        let a = encrypt(&key, 0, b"x");
        let b = encrypt(&key, 1, b"x");
        assert_ne!(a, b);
    }

    /// Cross-implementation vectors against the mobile side
    /// (`mobile/src/lib/relayCrypto.ts`, @noble/ciphers + @noble/hashes).
    /// Same token MUST produce the same HKDF key, the same HMAC proof, and
    /// byte-identical ciphertext — otherwise the two ends can't talk.
    #[test]
    fn noble_cross_implementation_vectors() {
        fn to_hex(bytes: &[u8]) -> String {
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        }
        let token = "test-token-000000000000000000000000";
        let key = derive_session_key(token);
        assert_eq!(
            to_hex(&key),
            "0dd41b92b433cdd0f2a1bda1ccfc090629af542ea31b2298722c9a98824a2ebf"
        );
        assert_eq!(
            compute_pair_proof(token),
            "f0ad7888264ad65376e1a0739476a08580837db7cbac0ecd5103184bb70a3070"
        );
        let frame = encrypt(&key, 1, b"conduit interop vector");
        assert_eq!(
            to_hex(&frame),
            concat!(
                "000000000000000000000000000000000000000000000001",
                "865307e9deb29aae8a1bb95abf85b9f3e625fd25a39c108129471e7ea1d8c8e7669fe4571e80"
            )
        );
    }
}
