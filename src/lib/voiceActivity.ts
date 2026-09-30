// Speech-activity gate for barge-in — the decision half of interrupting
// read-aloud with your voice.
//
// Consumes mic RMS levels (256 ms chunks — the exact cadence the dictation
// capture produces) plus a "is the TTS actually sounding right now" flag,
// and decides when SUSTAINED speech is present. Pure and synchronous, so the
// policy is unit-testable without a microphone: feed it numbers, act on the
// events it returns.
//
// Two hard-won rules live here, both learned from live-run logs:
//
//  · Calibrate on SOUNDING audio only. The first version started its
//    calibration window when the loop's speaking phase began — which is
//    seconds before the first audio (the engine is still synthesizing). The
//    window measured a silent room, the voice threshold collapsed to the
//    noise floor, and the gate then "confirmed" a barge-in on the TTS's own
//    sound and cut the read a few words in. Conversely, a window that waits
//    for audio would never close during "waiting" (the model is generating,
//    nothing sounds) — so the two cases are treated separately: NON-sounding
//    chunks follow the plain noise-floor rule from the first chunk (no
//    playback, no echo, any loudness is a voice), and only SOUNDING chunks
//    pass through the echo-measurement window before the echo threshold
//    applies to them.
//
// A deliberate non-feature: the ceiling is NOT ratcheted by loud runs that
// die unsustained. Such a run is usually echo — but it is indistinguishable
// from a real voice's inter-word dip, and folding those into the ceiling
// deafens the gate to the person it exists to hear. The headroom multiplier
// and the 3-chunk confirm window absorb echo's passage-to-passage variation
// instead.
//
// The measured ceiling seeds the NEXT episode (module-level, one user's
// room): episode 2+ arms instantly instead of deaf for another 1.3 s, and
// only a device/room change needs the re-measure — which the ratchet
// absorbs within one episode.

export type VoiceGateEvent = "suspect" | "confirm";

export interface VoiceGateConfig {
  /** Absolute minimum RMS that counts as sound at all. Typical mic noise
   *  floors sit around 0.002–0.006 RMS; the dictation capture uses a fixed
   *  0.008 for its (push-to-talk, headphones-tolerant) segmenter. */
  minThreshold: number;
  /** Sound must clear `noiseFloor * floorMultiplier` on top of the minimum. */
  floorMultiplier: number;
  /** Sustained chunks above the voice threshold that confirm a barge-in
   *  (~256 ms each). Three — under a second of loud speech, but long enough
   *  that a single dynamic TTS passage cannot confirm on its own. */
  confirmChunks: number;
  /** SOUNDING chunks measured before the echo ceiling is trusted. Five ≈
   *  1.3 s of actual audio. */
  calibChunks: number;
  /** The armed voice threshold while audio sounds: `max(minThreshold,
   *  echoPeak * multiplier, floor * floorMultiplier)` — above the speakers'
   *  bleed at the mic, so the speakers cannot trigger their own death. */
  echoMultiplier: number;
  /** A sounding chunk at or above `echoPeak * suspectMultiplier` (but below
   *  the voice threshold) emits one "suspect" — the caller ducks the
   *  playback for a probe, which collapses the echo and lets a NORMAL voice
   *  confirm against the plain floor rule. */
  suspectMultiplier: number;
  /** Headphones: the mic never hears the TTS, so there is no echo to
   *  calibrate — arm on the plain noise-floor rule immediately. */
  echoGuard: boolean;
}

export const DEFAULT_VOICE_GATE: VoiceGateConfig = {
  minThreshold: 0.016,
  floorMultiplier: 2.6,
  confirmChunks: 3,
  calibChunks: 5,
  echoMultiplier: 1.5,
  suspectMultiplier: 1.1,
  echoGuard: true,
};

/** Clamp range for the adaptive floor — below this a "quiet" room reads as
 *  digital zero and above it no real voice clears the multiplier. */
const FLOOR_MIN = 0.0015;
const FLOOR_MAX = 0.02;

/** The echo ceiling measured by the most recent calibration anywhere in this
 *  run — the room and speaker volume do not change between episodes, so the
 *  next episode seeds from it and arms instantly. */
let lastMeasuredEcho = 0;

/** Forget the measured echo ceiling — call when the audio device or speaker
 *  output changes (the next episode re-measures from scratch). Exported for
 *  that and for test isolation. */
export function resetEchoCalibration(): void {
  lastMeasuredEcho = 0;
}

export class VoiceActivityGate {
  private cfg: VoiceGateConfig;
  private state: "armed" | "confirmed" = "armed";
  /** SOUNDING chunks left before the echo ceiling is trusted. While this is
   *  above zero, sounding chunks measure the bleed and never confirm — a
   *  voice cannot be told apart from the TTS's first moments. Non-sounding
   *  chunks are unaffected: when nothing plays there is no echo, so the
   *  plain floor rule applies from the very first chunk (this is what keeps
   *  barge-in responsive during "waiting", where audio never comes). */
  private echoCalibLeft: number;
  private echoPeak: number;
  private run = 0;
  private runPeak = 0;
  private floor: number;
  /** Latched between a "suspect" emission and the caller's endProbe() — one
   *  duck per spike, not one per chunk. */
  private suspected = false;

  constructor(cfg: Partial<VoiceGateConfig> = {}, initialFloor = 0.004) {
    this.cfg = { ...DEFAULT_VOICE_GATE, ...cfg };
    this.floor = Math.min(Math.max(initialFloor, FLOOR_MIN), FLOOR_MAX);
    // A previously measured ceiling (same room, same speakers) skips the
    // window entirely; headphones never calibrate at all.
    this.echoPeak = this.cfg.echoGuard ? lastMeasuredEcho : 0;
    const seeded = this.echoPeak * this.cfg.echoMultiplier >= this.cfg.minThreshold;
    this.echoCalibLeft = this.cfg.echoGuard && !seeded ? this.cfg.calibChunks : 0;
  }

  /** Current sound threshold (exposed for tests and diagnostics). `sounding`
   *  mirrors the caller's "is the TTS actually producing audio right now":
   *  with nothing sounding there is no echo, so only the room floor applies.
   *  Infinity = the echo window is still measuring sounding audio. */
  threshold(sounding = true): number {
    if (this.state === "confirmed") return Infinity;
    if (sounding && this.echoCalibLeft > 0) return Infinity;
    const byEcho = sounding ? this.echoPeak * this.cfg.echoMultiplier : 0;
    return Math.max(this.cfg.minThreshold, byEcho, this.floor * this.cfg.floorMultiplier);
  }

  /** Forget everything. Call after acting on a confirm, or when playback
   *  changes under the gate. The measured ceiling carries over — same room,
   *  same speakers — so the next episode arms immediately. */
  reset(): void {
    this.state = "armed";
    this.echoPeak = this.cfg.echoGuard ? lastMeasuredEcho : 0;
    this.echoCalibLeft =
      this.cfg.echoGuard && this.echoPeak * this.cfg.echoMultiplier < this.cfg.minThreshold
        ? this.cfg.calibChunks
        : 0;
    this.run = 0;
    this.runPeak = 0;
    this.suspected = false;
  }

  /** Close the probe the caller opened in response to a "suspect" (the duck
   *  expired without a confirm). Re-arms the latch so a later spike can
   *  suspect again. */
  endProbe(): void {
    this.suspected = false;
  }

  /** Feed one chunk's RMS. `sounding` = the TTS is producing audio right now
   *  (the caller reads it off the player's phase). Returns the event to act
   *  on, or null. */
  feed(rms: number, sounding: boolean): VoiceGateEvent | null {
    if (this.state === "confirmed") return null; // latched until reset()

    // Echo window: sounding chunks measure the bleed and must never confirm
    // (the TTS's own first moments are indistinguishable from a voice).
    if (sounding && this.echoCalibLeft > 0) {
      this.echoPeak = Math.max(this.echoPeak, rms);
      this.echoCalibLeft -= 1;
      if (this.echoCalibLeft === 0) lastMeasuredEcho = this.echoPeak;
      return null;
    }

    const loud = rms >= this.threshold(sounding);
    if (!loud) {
      // A sounding chunk above the raw bleed but below the voice threshold:
      // ambiguous — echo dynamics or the start of a voice. Emit one
      // "suspect" so the caller can duck the playback and re-listen with the
      // plain floor rule (see useVoiceLoop's probe).
      if (
        sounding &&
        !this.suspected &&
        this.cfg.echoGuard &&
        this.echoPeak > 0 &&
        rms >= Math.max(this.cfg.minThreshold, this.echoPeak * this.cfg.suspectMultiplier)
      ) {
        this.suspected = true;
        return "suspect";
      }
      // Quiet chunk: the floor drifts toward it (EMA), clamped. Only quiet
      // chunks move the floor — a loud chunk must not raise the bar behind
      // itself, or sustained speech would silence the gate mid-word.
      this.floor += (Math.min(rms, this.floor) - this.floor) * 0.04;
      this.floor = Math.min(Math.max(this.floor, FLOOR_MIN), FLOOR_MAX);
      this.run = 0;
      this.runPeak = 0;
      return null;
    }

    this.run += 1;
    this.runPeak = Math.max(this.runPeak, rms);
    if (this.run >= this.cfg.confirmChunks) {
      this.state = "confirmed";
      return "confirm";
    }
    return null;
  }
}

/** Open the mic and feed chunk RMS values to `feed` until the returned stop
 *  function runs. Capture mirrors the dictation stack's shape (16 kHz
 *  AudioContext, ScriptProcessor, silent sink) so the two paths see the same
 *  chunk cadence and never fight over graph conventions. No transcription
 *  happens here — this watcher exists to catch speech during playback, so it
 *  deliberately retains nothing. */
export async function startMicLevelFeed(
  feed: (rms: number) => void,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0; // silent sink keeps the graph pulled without echo
  processor.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    feed(Math.sqrt(sum / data.length));
  };
  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    processor.onaudioprocess = null;
    try {
      source.disconnect();
      processor.disconnect();
      sink.disconnect();
    } catch {
      /* graph already torn down */
    }
    void ctx.close().catch(() => {});
    stream.getTracks().forEach((t) => t.stop());
  };
}
