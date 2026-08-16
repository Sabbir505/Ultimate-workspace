/**
 * E2E encryption for the mobile ↔ desktop relay channel (§3.2.11).
 *
 * Mirrors `src-tauri/src/mobile/relay_crypto.rs` exactly — the constants,
 * derivation, nonce layout, and frame format are pinned by the
 * `noble_cross_implementation_vectors` test on the Rust side:
 *
 * - Session key: HKDF-SHA256(ikm = token, salt = "conduit-e2e-relay-salt-v1",
 *   info = "conduit-e2e-relay-v1", 32 bytes).
 * - Pairing proof: lowercase-hex HMAC-SHA256(key = token, msg = "E2E").
 *   The raw token never rides the wire.
 * - Frame: `[24-byte nonce][ciphertext || 16-byte Poly1305 tag]`, where the
 *   nonce is 16 zero bytes + the per-direction counter as big-endian u64.
 *   Counters start at 0 after pairing and never reuse a nonce.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

const HKDF_SALT = 'conduit-e2e-relay-salt-v1';
const HKDF_INFO = 'conduit-e2e-relay-v1';

const te = new TextEncoder();

/** Derive the 32-byte XChaCha20 session key from the 256-bit pairing token. */
export function deriveSessionKey(token: string): Uint8Array {
  return hkdf(
    sha256,
    te.encode(token),
    te.encode(HKDF_SALT),
    te.encode(HKDF_INFO),
    32,
  );
}

/** Compute the pairing proof: hex(HMAC-SHA256(key = token, msg = "E2E")). */
export function computePairProof(token: string): string {
  const mac = hmac(sha256, te.encode(token), te.encode('E2E'));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

function counterNonce(counter: number): Uint8Array {
  const nonce = new Uint8Array(24);
  new DataView(nonce.buffer).setBigUint64(16, BigInt(counter));
  return nonce;
}

/** Encrypt one frame: nonce-prefixed AEAD ciphertext, ready for a Binary WS frame. */
export function encryptFrame(
  key: Uint8Array,
  counter: number,
  plaintext: Uint8Array,
): Uint8Array {
  const nonce = counterNonce(counter);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const frame = new Uint8Array(24 + ct.length);
  frame.set(nonce);
  frame.set(ct, 24);
  return frame;
}

/** Decrypt a frame produced by `encryptFrame`. Returns null on wrong key,
 *  tampering, or a nonce that doesn't match the expected counter. */
export function decryptFrame(
  key: Uint8Array,
  counter: number,
  frame: Uint8Array,
): Uint8Array | null {
  if (frame.length < 24 + 16) return null;
  const expected = counterNonce(counter);
  for (let i = 0; i < 24; i++) {
    if (frame[i] !== expected[i]) return null;
  }
  try {
    return xchacha20poly1305(key, frame.slice(0, 24)).decrypt(frame.slice(24));
  } catch {
    // Poly1305 tag mismatch — treat as tampered/undecryptable.
    return null;
  }
}
