//! E2E encryption for the mobile ↔ desktop relay channel (§3.2.11).
//!
//! **Design:** the 256-bit pairing token is a genuine pre-shared secret (it
//! travels out-of-band in the pairing URL/QR fragment and is NEVER sent over the
//! wire). Both sides derive a 32-byte XChaCha20 session key from it via
//! HKDF-SHA256. The phone proves token possession with `Hex(HMAC-SHA256(token,
//! "E2E"))` in the Pair frame instead of sending the raw token — or, since
//! 2026-10-01, with `Hex(HMAC-SHA256(token, "E2E-NONCE-V1" || challenge))`
//! where `challenge` is a fresh 32-byte nonce the desktop sends in a
//! `PairChallenge` frame when the connection opens, binding the proof to THAT
//! connection so a captured proof cannot be replayed (the legacy static proof
//! remains the pre-v2-client fallback). Every post-pair frame is then
//! AEAD-encrypted with XChaCha20-Poly1305 (24-byte nonce, 16-byte tag).
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
/// LEGACY derivation (static salt) — kept for the pinned cross-implementation
/// vectors; live pairing now uses [`derive_session_key_with_salt`].
pub fn derive_session_key(token: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), token.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm).expect("HKDF 32-byte output");
    okm
}

/// Per-connection derivation (audit C1 fix, 2026-09-21): the session key is
/// `HKDF(ikm = token, salt = conn_salt)` where `conn_salt` is a fresh random
/// value the desktop generates per pairing and sends in the plaintext
/// `PairOk` frame. The salt is public — secrecy rests on the token alone —
/// but a fresh salt makes the key unique per CONNECTION, so the counter
/// nonces reset at reconnect can no longer repeat (key, nonce) pairs across
/// connections of one desktop run. It also retroactively neutralizes the
/// replayable static pairing proof: an attacker who replays a captured
/// proof is paired and receives a salt, but cannot derive the key without
/// the token, so every frame they send fails the tag check.
pub fn derive_session_key_with_salt(token: &str, salt: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(salt), token.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm).expect("HKDF 32-byte output");
    okm
}

/// Fresh random per-pairing salt (32 bytes).
pub fn random_salt() -> [u8; 32] {
    use rand::RngCore;
    let mut salt = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

/// Bind the public `PairOk` salt to this connection's challenge:
/// `SHA256(challenge || salt)`.
///
/// The `PairOk` frame is unauthenticated plaintext, so a relay MITM can record
/// connection N's salt and replay it on connection N+1. Deriving the key from
/// the RAW salt then re-derives connection N's key while both per-direction
/// counters restart at 0 — XChaCha20 keystream reuse (XOR recovery of the
/// phone's plaintext) and Poly1305 one-time-key reuse (tag forgery) — which is
/// exactly what the MITM this relay exists to defeat can do. Folding in the
/// FRESH per-connection challenge makes a replayed salt produce a different
/// key; the phone additionally refuses a replayed challenge (audit C9, v3
/// pairing). Pre-v3 phones keep the raw-salt derivation.
pub fn bind_salt_to_challenge(challenge: &[u8], salt: &[u8]) -> [u8; 32] {
    use sha2::Digest as _;
    let mut h = Sha256::new();
    h.update(challenge);
    h.update(salt);
    let out = h.finalize();
    let mut bound = [0u8; 32];
    bound.copy_from_slice(&out);
    bound
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
///
/// S-1: FAIL CLOSED on an empty expected token. The proof is
/// `HMAC(key=token, "E2E")` — with an empty token that is a deterministic,
/// publicly computable constant, so an unguarded verify would pair ANY peer
/// whenever the stored `mobile.pairing_token` row is missing or unreadable.
/// (The legacy raw-token compare had this guard; the E2E path was missed.)
pub fn verify_pair_proof(expected_token: &str, presented: &str) -> bool {
    if expected_token.is_empty() {
        return false;
    }
    let ours = compute_pair_proof(expected_token);
    // Constant-time compare via subtle.
    ours.as_bytes().ct_eq(presented.as_bytes()).into()
}

// ---------------------------------------------------------------------------
// Challenge-bound pairing proof (2026-10-01 anti-replay upgrade)
//
// The static proof above is constant for the lifetime of the token, so a
// proof captured once (malicious LAN peer, shared network, leaked frame) can
// be replayed indefinitely. The fix: the desktop opens every connection by
// sending a fresh 32-byte challenge (the plaintext `PairChallenge` frame),
// and challenge-capable clients prove possession with
// `HMAC(key = token, "E2E-NONCE-V1" || challenge)` — a proof that only
// verifies on the connection it was minted for. The legacy static proof
// remains the fallback for old clients; `mobile.pairing.require_challenge`
// flips the desktop to refuse it once every client is upgraded.
// ---------------------------------------------------------------------------

/// Domain-separation label for the challenge-bound proof. Distinct from the
/// legacy `"E2E"` message so a challenge-bound proof can never be confused
/// with (or replayed as) a static one, and vice versa.
pub const PAIR_CHALLENGE_LABEL: &[u8] = b"E2E-NONCE-V1";

/// Fresh random per-connection pairing challenge (32 bytes).
pub fn random_challenge() -> [u8; 32] {
    use rand::RngCore;
    let mut challenge = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut challenge);
    challenge
}

/// Compute the challenge-bound pairing proof:
/// lowercase-hex `HMAC-SHA256(key = token, data = "E2E-NONCE-V1" || challenge)`.
pub fn compute_pair_proof_with_nonce(token: &str, challenge: &[u8]) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(token.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(PAIR_CHALLENGE_LABEL);
    mac.update(challenge);
    let out = mac.finalize().into_bytes();
    out.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Verify a challenge-bound pairing proof in constant time against the
/// desktop's own derivation for the expected token + THIS connection's
/// challenge. Fails closed on an empty expected token (S-1, same reasoning
/// as [`verify_pair_proof`]).
pub fn verify_pair_proof_with_nonce(expected_token: &str, challenge: &[u8], presented: &str) -> bool {
    if expected_token.is_empty() {
        return false;
    }
    let ours = compute_pair_proof_with_nonce(expected_token, challenge);
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
    fn salted_key_differs_from_legacy_and_binds_the_salt() {
        let token = "token-one-0000000000000000000000";
        let legacy = derive_session_key(token);
        let k1 = derive_session_key_with_salt(token, b"conn-salt-A");
        let k2 = derive_session_key_with_salt(token, b"conn-salt-A");
        let k3 = derive_session_key_with_salt(token, b"conn-salt-B");
        assert_eq!(k1, k2, "same salt must be deterministic");
        assert_ne!(k1, k3, "different connection salts must differ");
        assert_ne!(k1, legacy, "salted derivation must not equal the legacy key");
    }

    #[test]
    fn encrypt_decrypt_roundtrip_with_salted_key() {
        let key = derive_session_key_with_salt("tok-000000000000000000000000", b"s");
        let ct = encrypt(&key, 0, b"hello");
        assert_eq!(decrypt(&key, 0, &ct).as_deref(), Some(b"hello".as_slice()));
        assert_eq!(decrypt(&key, 1, &ct), None);
    }

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
    fn pair_proof_round_trip() {
        let proof = compute_pair_proof("secret-token");
        assert!(verify_pair_proof("secret-token", &proof));
        assert!(!verify_pair_proof("other-token", &proof));
    }

    #[test]
    fn pair_proof_fails_closed_on_empty_token() {
        // S-1: with the token missing, the well-known HMAC("") proof must
        // NOT pair — and neither may any other proof.
        assert!(!verify_pair_proof("", &compute_pair_proof("")));
        let proof = compute_pair_proof("attacker");
        assert!(!verify_pair_proof("", &proof));
    }

    #[test]
    fn proof_roundtrip_and_wrong_token() {
        let token = "correct-token-000000000000000000000000";
        let proof = compute_pair_proof(token);
        assert!(verify_pair_proof(token, &proof));
        assert!(!verify_pair_proof("wrong-token-00000000000000000000000", &proof));
    }

    #[test]
    fn challenge_proof_roundtrip_and_wrong_challenge() {
        let token = "challenge-token-000000000000000000000";
        let c1 = random_challenge();
        let c2 = random_challenge();
        let proof = compute_pair_proof_with_nonce(token, &c1);
        assert!(verify_pair_proof_with_nonce(token, &c1, &proof));
        assert!(
            !verify_pair_proof_with_nonce(token, &c2, &proof),
            "a proof bound to one connection's challenge must not verify on another"
        );
        assert!(!verify_pair_proof_with_nonce("other-token", &c1, &proof));
        // The two domains are separate: a challenge-bound proof is never a
        // valid static proof and vice versa.
        assert!(!verify_pair_proof(token, &proof), "nonce proof must not pass the static check");
        let static_proof = compute_pair_proof(token);
        assert!(
            !verify_pair_proof_with_nonce(token, &c1, &static_proof),
            "static proof must not pass the challenge check"
        );
    }

    #[test]
    fn challenge_proof_fails_closed_on_empty_token() {
        let proof = compute_pair_proof_with_nonce("attacker", b"challenge");
        assert!(!verify_pair_proof_with_nonce("", b"challenge", &proof));
    }

    #[test]
    fn challenge_proof_is_deterministic_and_64_hex() {
        let token = "det-token-00000000000000000000000000";
        let challenge = [7u8; 32];
        let a = compute_pair_proof_with_nonce(token, &challenge);
        let b = compute_pair_proof_with_nonce(token, &challenge);
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
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
        // Challenge-bound proof (anti-replay, 2026-10-01), pinned against the
        // same @noble/hashes TS implementation: HMAC(token, "E2E-NONCE-V1" ||
        // [7u8; 32]) for the token above. Verified live against the mobile
        // node_modules copy of @noble/hashes; if either side changes its
        // derivation the two ends can no longer pair.
        let challenge = [7u8; 32];
        assert_eq!(
            compute_pair_proof_with_nonce(token, &challenge),
            "46ac63c28989019d0a2ed8c922629745af78fce99524eb45170e845e0e9f1ce2"
        );
        // The plaintext below is part of the test vector: the expected frame is
        // precomputed against it (and the noble TS implementation) — do not rebrand.
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
