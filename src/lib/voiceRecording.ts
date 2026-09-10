// Voice-recording PCM utilities for ChatComposer's mic capture: chunk
// concatenation with linear resampling to 16 kHz, WAV encoding, and chunked
// base64. Pure functions — no React, no AudioContext lifecycle.

/** Concatenate captured Float32 sample chunks into one buffer, resampling
 *  linearly when the AudioContext couldn't run at 16 kHz natively. whisper.cpp
 *  consumes 16 kHz mono PCM, and capturing at (or converting to) that rate
 *  here removes any ffmpeg dependency from the STT path. */
export function joinSamples(chunks: Float32Array[], fromRate: number): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const raw = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    raw.set(c, off);
    off += c.length;
  }
  if (fromRate === 16000 || total === 0) return raw;
  const ratio = fromRate / 16000;
  const out = new Float32Array(Math.max(1, Math.floor(total / ratio)));
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const a = raw[i0] ?? 0;
    const b = raw[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Canonical 44-byte WAV header + 16-bit LE PCM around 16 kHz mono samples. */
export function encodeWav16k(pcm: Float32Array): Blob {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 16000, true); // sample rate
  view.setUint32(28, 32000, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  wstr(36, "data");
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** Chunked base64 — spreading the whole buffer into String.fromCharCode
 *  throws RangeError on clips > ~100KB. 8KB chunks are safe and fast. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
