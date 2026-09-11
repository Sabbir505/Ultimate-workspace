// Voice preview for Settings → Local Models → Speech: "what does THIS voice
// sound like?" before committing an answer to it.
//
// Deliberately separate from lib/tts (the read-aloud player): that one is a
// queue with a lookahead pipeline, a global transport bar and a store the whole
// transcript watches. A preview is one short sentence, one buffer, no queue —
// and reusing the player would make the floating transport bar appear over the
// settings screen and pin the preview to the player's own voice resolution
// instead of the voice the picker is showing.
import { create } from "zustand";
import { ttsSpeak } from "./ipc";
import { sharedAudioContext } from "./sound";
import { useTtsStore } from "../state/tts";

/** Sample sentence. Long enough to hear the timbre and the pace, short enough
 *  that previewing a dozen voices does not take a minute. */
export const PREVIEW_TEXT = "Here is how this voice reads an answer aloud.";

/** How many samples may be voiced speculatively before the user asks for one.
 *  Each is ~100 KB on disk out of a 512 MB cache, so space is not the concern —
 *  engine time is: hovering down a 50-voice list should not voice the whole
 *  catalog while nobody is listening. */
const PREFETCH_BUDGET = 10;

export type PreviewPhase = "idle" | "loading" | "playing" | "paused";

export interface VoicePreviewState {
  /** Voice being previewed, or null when nothing has been played yet. */
  voice: string | null;
  phase: PreviewPhase;
  error: string | null;
  set: (patch: Partial<Omit<VoicePreviewState, "set">>) => void;
}

export const useVoicePreviewStore = create<VoicePreviewState>((set) => ({
  voice: null,
  phase: "idle",
  error: null,
  set: (patch) => set(patch),
}));

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

class VoicePreview {
  private source: AudioBufferSourceNode | null = null;
  /** Decoded samples by voice: a voice tried once costs nothing to try again,
   *  which is what makes clicking down the list feel instant. */
  private samples = new Map<string, AudioBuffer>();
  /** Samples being voiced right now, so a hover that turns into a click shares
   *  the one synthesis instead of queueing a second. */
  private pending = new Map<string, Promise<AudioBuffer | null>>();
  /** Buffer currently loaded for playback (pause/resume positions in it). */
  private buffer: AudioBuffer | null = null;
  /** Resume point inside `buffer`, in seconds. */
  private offset = 0;
  private startedAt = 0;
  private prefetched = 0;

  /** Voice the sample for `voice` WITHOUT playing it — hover intent. Voices
   *  the pointer actually visits are then ready before the click. */
  prefetch(voice: string): void {
    if (this.prefetched >= PREFETCH_BUDGET) return;
    if (this.samples.has(voice) || this.pending.has(voice)) return;
    // Never compete with a read-aloud: the engine voices one thing at a time,
    // so a speculative sample would sit in front of sentences someone is
    // listening to.
    if (useTtsStore.getState().phase !== "idle") return;
    this.prefetched += 1;
    void this.sample(voice);
  }

  /** A fresh visit to the picker gets a fresh speculative budget. */
  resetPrefetchBudget(): void {
    this.prefetched = 0;
  }

  /** Play `voice` — or pause/resume it when it is already the one playing. */
  toggle(voice: string): void {
    const state = useVoicePreviewStore.getState();
    if (state.voice === voice && state.phase === "playing") {
      this.pause();
      return;
    }
    if (state.voice === voice && state.phase === "paused") {
      this.resume();
      return;
    }
    void this.play(voice);
  }

  async play(voice: string): Promise<void> {
    this.stopSource();
    this.buffer = null;
    this.offset = 0;
    const store = useVoicePreviewStore.getState();
    store.set({ voice, phase: "loading", error: null });

    const ctx = sharedAudioContext();
    if (!ctx) {
      store.set({ phase: "idle", voice: null, error: "Audio playback is unavailable" });
      return;
    }
    const buffer = await this.sample(voice);
    // Superseded by another row while this one was being voiced.
    if (useVoicePreviewStore.getState().voice !== voice) return;
    if (!buffer) {
      store.set({ phase: "idle", voice: null, error: "Could not voice this sample" });
      return;
    }
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* stays suspended — playback below simply will not advance */
      }
    }
    this.buffer = buffer;
    this.start(ctx, 0, voice);
  }

  pause(): void {
    if (!this.source || !this.buffer) return;
    const ctx = sharedAudioContext();
    if (ctx) this.offset = (this.offset + (ctx.currentTime - this.startedAt)) % this.buffer.duration;
    this.stopSource();
    useVoicePreviewStore.getState().set({ phase: "paused" });
  }

  resume(): void {
    const voice = useVoicePreviewStore.getState().voice;
    const ctx = sharedAudioContext();
    if (!voice || !this.buffer || !ctx) return;
    this.start(ctx, this.offset, voice);
  }

  /** Stop playback and clear the transport — the sample cache survives, so the
   *  same voice plays instantly next time. */
  stop(): void {
    this.stopSource();
    this.buffer = null;
    this.offset = 0;
    useVoicePreviewStore.getState().set({ voice: null, phase: "idle", error: null });
  }

  /** The decoded sample for a voice: cached, in flight, or voiced now. */
  private sample(voice: string): Promise<AudioBuffer | null> {
    const hit = this.samples.get(voice);
    if (hit) return Promise.resolve(hit);
    const inFlight = this.pending.get(voice);
    if (inFlight) return inFlight;
    const job = this.fetchSample(voice).finally(() => this.pending.delete(voice));
    this.pending.set(voice, job);
    return job;
  }

  private async fetchSample(voice: string): Promise<AudioBuffer | null> {
    try {
      // `null` speed: the backend fills in the configured pace, so a preview
      // sounds like the read will.
      const audio = await ttsSpeak(PREVIEW_TEXT, voice, null);
      if (!audio?.audioBase64) return null;
      const ctx = sharedAudioContext();
      if (!ctx) return null;
      const buffer = await ctx.decodeAudioData(
        base64ToBytes(audio.audioBase64).buffer as ArrayBuffer,
      );
      this.samples.set(voice, buffer);
      return buffer;
    } catch (err) {
      console.warn("[relay] voice preview failed", err);
      return null;
    }
  }

  private stopSource(): void {
    const src = this.source;
    this.source = null;
    if (!src) return;
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* never started, or already stopped */
    }
  }

  private start(ctx: AudioContext, offset: number, voice: string): void {
    if (!this.buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(ctx.destination);
    const startAt = Math.min(Math.max(offset, 0), Math.max(this.buffer.duration - 0.02, 0));
    src.onended = () => {
      if (this.source === src) this.source = null;
      this.buffer = null;
      this.offset = 0;
      // The sample finished: back to a Play button, ready for the next voice.
      useVoicePreviewStore.getState().set({ phase: "idle", voice: null });
    };
    this.source = src;
    this.startedAt = ctx.currentTime;
    this.offset = startAt;
    try {
      src.start(0, startAt);
    } catch (err) {
      console.warn("[relay] voice preview playback failed", err);
      this.source = null;
    }
    useVoicePreviewStore.getState().set({ phase: "playing", voice });
  }
}

export const voicePreview = new VoicePreview();

/** True when this voice is the one currently being previewed. */
export function isPreviewing(state: VoicePreviewState, voice: string | null): boolean {
  return !!voice && state.voice === voice && state.phase !== "idle";
}
