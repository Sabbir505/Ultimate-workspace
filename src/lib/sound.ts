// Lightweight notification sound via the Web Audio API — no asset files
// needed (a short two-note "complete" chime is synthesized on demand). The
// AudioContext is created lazily on first use (and after a user gesture, which
// browsers require before audio can play) and reused thereafter.
//
// Best-effort and silent on failure: if the Web Audio API is unavailable or
// autoplay is blocked, the call is a no-op so the OS toast still works.

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  // A context can start "suspended" until a user gesture resumes it; resume
  // best-effort (the promise is intentionally un-awaited so the chime isn't
  // delayed by it).
  try {
    void ctx.resume();
  } catch {
    /* ignore */
  }
  return ctx;
}

/** Play a short, soft two-note chime suitable for a "task finished /
 *  needs input" notification. No-op when Web Audio is unavailable. */
export function playNotifyChime(): void {
  const ac = ensureCtx();
  if (!ac) return;
  try {
    const now = ac.currentTime;
    // Two quick sine tones (E6 then A6) with a gentle exponential decay —
    // pleasant and unobtrusive, distinct from an error buzz.
    const notes = [
      { freq: 1318.51, start: 0 }, // E6
      { freq: 1760.0, start: 0.12 }, // A6
    ];
    for (const n of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = n.freq;
      const t = now + n.start;
      const dur = 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  } catch {
    /* synth failure — no-op */
  }
}

/** Calm "an agent finished" chime for when Relay is NOT the focused app —
 *  quieter and slower than the notify chime so it reads as a gentle
 *  background cue rather than an alert. Two triangle tones (C6 → G5, a
 *  falling fourth) with a slow attack and long decay: a resolved, relaxed
 *  gesture that won't startle someone working in another window. */
export function playCompletionChime(): void {
  const ac = ensureCtx();
  if (!ac) return;
  try {
    const now = ac.currentTime;
    const notes = [
      { freq: 1046.5, start: 0, gain: 0.09 }, // C6
      { freq: 783.99, start: 0.22, gain: 0.07 }, // G5
    ];
    for (const n of notes) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "triangle";
      osc.frequency.value = n.freq;
      const t = now + n.start;
      const dur = 0.6;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(n.gain, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  } catch {
    /* synth failure — no-op */
  }
}
