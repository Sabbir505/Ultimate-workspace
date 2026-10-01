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

/**
 * Derive the 32-byte XChaCha20 session key from the 256-bit pairing token.
 * With `salt` (the desktop's per-connection value from PairOk), the key is
 * `HKDF(ikm = token, salt = connection salt)` — unique per connection, so the
 * per-connect counter reset can never reuse (key, nonce) pairs (audit C1).
 * Without a salt, the legacy static-salt derivation is used.
 */
export function deriveSessionKey(token: string, salt?: Uint8Array): Uint8Array {
  return hkdf(
    sha256,
    te.encode(token),
    salt ?? te.encode(HKDF_SALT),
    te.encode(HKDF_INFO),
    32,
  );
}

/** Decode base64url (no padding) — the PairOk salt encoding. */
export function b64UrlToBytes(s: string): Uint8Array {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const ch of clean) {
    const v = table.indexOf(ch);
    if (v < 0) throw new Error('invalid base64url character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Compute the pairing proof: hex(HMAC-SHA256(key = token, msg = "E2E")). */
export function computePairProof(token: string): string {
  const mac = hmac(sha256, te.encode(token), te.encode('E2E'));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Domain-separation label for the challenge-bound pairing proof — mirrors
 * `PAIR_CHALLENGE_LABEL` in `src-tauri/src/mobile/relay_crypto.rs`.
 */
export const PAIR_CHALLENGE_LABEL = 'E2E-NONCE-V1';

/**
 * Compute the challenge-bound pairing proof:
 * hex(HMAC-SHA256(key = token, msg = "E2E-NONCE-V1" || challenge)).
 * `challengeB64Url` is the desktop's per-connection `PairChallenge` nonce
 * (base64url, no padding). The proof only verifies on the connection whose
 * challenge it binds, so a captured Pair frame cannot be replayed.
 */
export function computePairProofWithNonce(token: string, challengeB64Url: string): string {
  const challenge = b64UrlToBytes(challengeB64Url);
  const label = te.encode(PAIR_CHALLENGE_LABEL);
  const msg = new Uint8Array(label.length + challenge.length);
  msg.set(label);
  msg.set(challenge, label.length);
  const mac = hmac(sha256, te.encode(token), msg);
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
