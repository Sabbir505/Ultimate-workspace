// Speech-activity gate for barge-in — the decision half of interrupting
// read-aloud with your voice.
//
// Consumes mic RMS levels (256 ms chunks — the exact cadence the dictation
// capture produces) and decides when SUSTAINED speech is present. Pure and
// synchronous, so the policy is unit-testable without a microphone: feed it
// numbers, act on the events it returns.
//
// Two-stage design — the "pause-and-check" echo guard. With speakers, the mic
// hears Relay's own TTS, so the first energy spike cannot be trusted as a
// voice: on the first suspect chunk the caller PAUSES playback, and the gate
// re-verifies against silence. Energy that persists with nothing playing was
// a voice → confirm (barge in). Energy that dropped was echo → clear, and the
// caller resumes playback from its remembered offset. With headphones the mic
// never hears the TTS, so the guard can be disabled and sustained energy
// confirms directly.
//
// Thresholds are adaptive: a slow noise floor (EMA over quiet chunks only —
// loud chunks must not drag it up after them) times a multiplier, clamped
// below by an absolute minimum. A fixed threshold either misses quiet voices
// on good mics or self-triggers on loud rooms; the floor adapts per room.

export type VoiceGateEvent = "suspect" | "confirm" | "clear";

export interface VoiceGateConfig {
  /** Absolute minimum RMS that counts as sound at all. Typical mic noise
   *  floors sit around 0.002–0.006 RMS; the dictation capture uses a fixed
   *  0.008 for its (push-to-talk, headphones-tolerant) segmenter. */
  minThreshold: number;
  /** Sound must clear `noiseFloor * floorMultiplier` on top of the minimum. */
  floorMultiplier: number;
  /** Sustained-sound chunks needed to confirm with the guard off (~256 ms each). */
  confirmChunks: number;
  /** Sustained-sound chunks needed to confirm while the pause-and-check is
   *  running — measured against SILENCE now that playback is paused, so this
   *  can be shorter than a headphone confirm. */
  echoCheckChunks: number;
  /** Pause playback on the first suspect chunk and re-verify against silence
   *  (speakers). Off = trust sustained energy directly (headphones). */
  echoGuard: boolean;
}

export const DEFAULT_VOICE_GATE: VoiceGateConfig = {
  minThreshold: 0.016,
  floorMultiplier: 2.6,
  confirmChunks: 2,
  echoCheckChunks: 2,
  echoGuard: true,
};

/** Clamp range for the adaptive floor — below this a "quiet" room reads as
 *  digital zero and above it no real voice clears the multiplier. */
const FLOOR_MIN = 0.0015;
const FLOOR_MAX = 0.02;

export class VoiceActivityGate {
  private cfg: VoiceGateConfig;
  private state: "idle" | "counting" | "checking" | "confirmed" = "idle";
  private run = 0;
  private floor: number;
  /** True while the caller is holding playback paused for a check — the
   *  caller owns the pause/resume actions; this only mirrors it so a reset()
   *  after a confirm doesn't lose track. */
  holdingPause = false;

  constructor(cfg: Partial<VoiceGateConfig> = {}, initialFloor = 0.004) {
    this.cfg = { ...DEFAULT_VOICE_GATE, ...cfg };
    this.floor = Math.min(Math.max(initialFloor, FLOOR_MIN), FLOOR_MAX);
  }

  /** Current sound threshold (exposed for tests and diagnostics). */
  get threshold(): number {
    return Math.max(this.cfg.minThreshold, this.floor * this.cfg.floorMultiplier);
  }

  /** Forget everything. Call after acting on a confirm, or when playback
   *  changes under the gate. `holdingPause` mirrors whether the caller is
   *  currently holding playback paused for this gate. */
  reset(holdingPause = false): void {
    this.state = "idle";
    this.run = 0;
    this.holdingPause = holdingPause;
  }

  /** Feed one chunk's RMS. Returns the event to act on, or null. */
  feed(rms: number): VoiceGateEvent | null {
    if (this.state === "confirmed") return null; // latched until reset()
    const loud = rms >= this.threshold;

    if (!loud) {
      // Quiet chunk: the floor drifts toward it (EMA), clamped. Only quiet
      // chunks move the floor — a loud chunk must not raise the bar behind
      // itself, or sustained speech would silence the gate mid-word.
      this.floor += (Math.min(rms, this.floor) - this.floor) * 0.04;
      this.floor = Math.min(Math.max(this.floor, FLOOR_MIN), FLOOR_MAX);
      if (this.state === "counting" || this.state === "checking") {
        const wasChecking = this.state === "checking";
        this.state = "idle";
        this.run = 0;
        if (wasChecking) {
          this.holdingPause = false;
          // The pause-and-check heard silence with playback stopped — that
          // was echo, not a voice. Caller resumes playback.
          return "clear";
        }
      }
      return null;
    }

    // Loud chunk. The floor stays put (see above).
    switch (this.state) {
      case "idle":
        this.run = 1;
        if (this.cfg.echoGuard) {
          // First spike while speaking — untrustworthy with speakers. The
          // caller pauses playback; the next chunks decide voice vs echo.
          this.state = "checking";
          this.holdingPause = true;
          return "suspect";
        }
        this.state = "counting";
        return null;
      case "counting":
        this.run += 1;
        if (this.run >= this.cfg.confirmChunks) {
          this.state = "confirmed";
          return "confirm";
        }
        return null;
      case "checking":
        // Playback is paused, so a LOUD chunk now is air the mic owns —
        // a real voice in the room.
        this.run += 1;
        if (this.run >= this.cfg.echoCheckChunks) {
          this.state = "confirmed";
          return "confirm";
        }
        return null;
      default:
        return null;
    }
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
