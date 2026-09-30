// Speech-activity gate for barge-in — the decision half of interrupting
// read-aloud with your voice.
//
// Consumes mic RMS levels (256 ms chunks — the exact cadence the dictation
// capture produces) and decides when SUSTAINED speech is present. Pure and
// synchronous, so the policy is unit-testable without a microphone: feed it
// numbers, act on the events it returns.
//
// The failure this design replaces: a "pause-and-check" echo guard that
// paused playback on the first spike and confirmed a barge-in if energy
// lasted two more chunks (~0.5 s). Real speaker echo outlives 0.5 s, so
// Relay kept hearing ITSELF, "confirming", and cutting its own read off a
// few words in — while the pause/resume cycling chopped whatever audio got
// out. Energy-only gating cannot tell a voice from an echo inside a single
// second.
//
// What it does instead — ECHO CALIBRATION, no pausing, ever:
//
//  1. calibrate — the first moments of each playback episode measure the
//     loudest the ROOM hears while nobody is talking (the speaker bleed).
//  2. arm — the voice threshold sits well ABOVE that bleed (echoMultiplier).
//     A human at the microphone is louder than speakers a meter away; the
//     speakers cannot trigger their own death.
//  3. confirm — sustained (confirmChunks) energy above the voice threshold.
//     Never a pause, never a mid-read silence, never a stutter.
//
// Cost: barge-in takes ~calibration + one confirm window (~2 s). Worth it —
// the alternative was the read dying mid-sentence. The quiet floor still
// adapts per room exactly as before.
export type VoiceGateEvent = "confirm";

export interface VoiceGateConfig {
  /** Absolute minimum RMS that counts as sound at all. Typical mic noise
   *  floors sit around 0.002–0.006 RMS; the dictation capture uses a fixed
   *  0.008 for its (push-to-talk, headphones-tolerant) segmenter. */
  minThreshold: number;
  /** Sound must clear `noiseFloor * floorMultiplier` on top of the minimum. */
  floorMultiplier: number;
  /** Sustained chunks above the voice threshold that confirm a barge-in
   *  (~256 ms each). Two — half a second of loud speech. */
  confirmChunks: number;
  /** Chunks of playback (with nobody speaking) measured before arming — the
   *  echo-bleed estimate. Five ≈ 1.3 s. */
  calibChunks: number;
  /** The armed voice threshold: `max(minThreshold, echoPeak * multiplier,
   *  floor * floorMultiplier)`. Above the speakers' bleed at the mic. */
  echoMultiplier: number;
  /** Headphones: the mic never hears the TTS, so calibration is skipped and
   *  the threshold is the plain noise-floor rule — barge-in arms instantly. */
  echoGuard: boolean;
}

export const DEFAULT_VOICE_GATE: VoiceGateConfig = {
  minThreshold: 0.016,
  floorMultiplier: 2.6,
  confirmChunks: 2,
  calibChunks: 5,
  echoMultiplier: 1.7,
  echoGuard: true,
};

/** Clamp range for the adaptive floor — below this a "quiet" room reads as
 *  digital zero and above it no real voice clears the multiplier. */
const FLOOR_MIN = 0.0015;
const FLOOR_MAX = 0.02;

export class VoiceActivityGate {
  private cfg: VoiceGateConfig;
  private state: "calibrating" | "armed" | "confirmed" = "calibrating";
  private calibLeft: number;
  private echoPeak = 0;
  private run = 0;
  private floor: number;

  constructor(cfg: Partial<VoiceGateConfig> = {}, initialFloor = 0.004) {
    this.cfg = { ...DEFAULT_VOICE_GATE, ...cfg };
    this.calibLeft = this.cfg.echoGuard ? this.cfg.calibChunks : 0;
    if (this.calibLeft === 0) this.state = "armed";
    this.floor = Math.min(Math.max(initialFloor, FLOOR_MIN), FLOOR_MAX);
  }

  /** Current sound threshold (exposed for tests and diagnostics). While
   *  calibrating it is deliberately impossible to clear — the estimate is
   *  not in yet. */
  get threshold(): number {
    if (this.state === "calibrating") return Infinity;
    const byEcho = this.cfg.echoGuard ? this.echoPeak * this.cfg.echoMultiplier : 0;
    return Math.max(this.cfg.minThreshold, byEcho, this.floor * this.cfg.floorMultiplier);
  }

  /** Forget everything. Call after acting on a confirm, or when playback
   *  changes under the gate — the next episode recalibrates. */
  reset(): void {
    this.state = this.cfg.echoGuard ? "calibrating" : "armed";
    this.calibLeft = this.cfg.echoGuard ? this.cfg.calibChunks : 0;
    this.echoPeak = 0;
    this.run = 0;
  }

  /** Feed one chunk's RMS. Returns the event to act on, or null. */
  feed(rms: number): VoiceGateEvent | null {
    if (this.state === "confirmed") return null; // latched until reset()

    if (this.state === "calibrating") {
      this.echoPeak = Math.max(this.echoPeak, rms);
      this.calibLeft -= 1;
      if (this.calibLeft <= 0) this.state = "armed";
      return null;
    }

    const loud = rms >= this.threshold;
    if (!loud) {
      // Quiet chunk: the floor drifts toward it (EMA), clamped. Only quiet
      // chunks move the floor — a loud chunk must not raise the bar behind
      // itself, or sustained speech would silence the gate mid-word.
      this.floor += (Math.min(rms, this.floor) - this.floor) * 0.04;
      this.floor = Math.min(Math.max(this.floor, FLOOR_MIN), FLOOR_MAX);
      this.run = 0;
      return null;
    }

    this.run += 1;
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
export async function startMicLevelFeed(feed: (rms: number) => void): Promise<() => void> {
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
