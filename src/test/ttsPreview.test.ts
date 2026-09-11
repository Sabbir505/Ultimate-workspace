// Settings → Speech voice audition. The point of the feature is choosing a
// voice by ear instead of by name, so the failure modes worth pinning are the
// ones that make that impossible: a sample that never starts, a pause that
// cannot be resumed, and a preview that keeps sounding after the picker has
// moved to a different voice.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({ ttsSpeak: vi.fn() }));
vi.mock("../lib/sound", () => ({ sharedAudioContext: vi.fn() }));

import { ttsSpeak, type TtsAudio } from "../lib/ipc";
import { sharedAudioContext } from "../lib/sound";
import { PREVIEW_TEXT, useVoicePreviewStore, voicePreview } from "../lib/ttsPreview";
import { useTtsStore } from "../state/tts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedWith: number | null = null;
  stopped = false;
  connect() {}
  start(_when: number, offset: number) {
    this.startedWith = offset;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeCtx {
  currentTime = 0;
  state = "running";
  destination = {};
  sources: FakeSource[] = [];
  resume() {
    return Promise.resolve();
  }
  createBufferSource() {
    const src = new FakeSource();
    this.sources.push(src);
    return src;
  }
  decodeAudioData(buf: ArrayBuffer) {
    return Promise.resolve({ duration: buf.byteLength / 1000, sampleRate: 24000 });
  }
  started() {
    return this.sources.filter((s) => s.startedWith !== null);
  }
}

let ctx: FakeCtx;
const audio = (ms: number): TtsAudio => ({
  audioBase64: btoa("\0".repeat(ms)),
  mime: "audio/wav",
  sampleRate: 24000,
  durationSec: ms / 1000,
  cached: false,
  voice: "v",
});

beforeEach(() => {
  voicePreview.stop();
  ctx = new FakeCtx();
  vi.clearAllMocks();
  vi.mocked(sharedAudioContext).mockReturnValue(ctx as unknown as AudioContext);
  vi.mocked(ttsSpeak).mockResolvedValue(audio(4000));
});

describe("voice preview", () => {
  it("voices the sample in the chosen voice at the configured pace", async () => {
    voicePreview.toggle("af_heart");
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));

    // null speed = "whatever Settings says", so the preview sounds like the
    // read will rather than like the default 1x.
    expect(ttsSpeak).toHaveBeenCalledWith(PREVIEW_TEXT, "af_heart", null);
    expect(useVoicePreviewStore.getState().phase).toBe("playing");
    expect(useVoicePreviewStore.getState().voice).toBe("af_heart");
  });

  it("pauses and resumes from the same point", async () => {
    voicePreview.toggle("am_michael");
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));

    ctx.currentTime = 1.25;
    voicePreview.toggle("am_michael"); // second click on the playing voice
    expect(useVoicePreviewStore.getState().phase).toBe("paused");
    expect(ctx.started()[0].stopped).toBe(true);

    voicePreview.toggle("am_michael");
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(2));
    expect(ctx.started()[1].startedWith).toBeCloseTo(1.25, 5);
  });

  it("drops the previous sample when the picker moves to another voice", async () => {
    // Fresh names: an auditioned voice stays decoded for the life of the
    // module, so a reused name would be served from cache and skip the engine
    // this test is watching.
    voicePreview.toggle("cv_first");
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));

    voicePreview.toggle("cv_second");
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(2));
    expect(ctx.started()[0].stopped).toBe(true);
    expect(vi.mocked(ttsSpeak).mock.lastCall?.[1]).toBe("cv_second");
  });

  it("reports a failed sample instead of leaving the button spinning", async () => {
    vi.mocked(ttsSpeak).mockRejectedValue(new Error("no engine"));
    voicePreview.toggle("voice_that_cannot_be_voiced");
    await vi.waitFor(() => expect(useVoicePreviewStore.getState().error).toBeTruthy());
    expect(useVoicePreviewStore.getState().phase).toBe("idle");
    expect(ctx.started()).toHaveLength(0);
  });

  it("voices a voice ahead of the click, and the click reuses it", async () => {
    voicePreview.resetPrefetchBudget();
    voicePreview.prefetch("bf_alice");
    await vi.waitFor(() => expect(ttsSpeak).toHaveBeenCalledTimes(1));
    expect(useVoicePreviewStore.getState().phase).toBe("idle"); // heard nothing yet

    voicePreview.toggle("bf_alice");
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));
    // The hover already paid for the synthesis and the decode.
    expect(ttsSpeak).toHaveBeenCalledTimes(1);
  });

  it("does not voice samples behind a read-aloud", async () => {
    voicePreview.resetPrefetchBudget();
    useTtsStore.setState({ phase: "playing" });
    voicePreview.prefetch("af_heart");
    await tick();
    // The engine voices one thing at a time: a speculative sample would sit in
    // front of the sentences someone is listening to.
    expect(ttsSpeak).not.toHaveBeenCalled();
    useTtsStore.setState({ phase: "idle" });
  });

  it("stops speculating once the budget is spent", async () => {
    voicePreview.resetPrefetchBudget();
    for (let i = 0; i < 15; i += 1) voicePreview.prefetch(`voice_${i}`);
    await tick();
    await tick();
    // Browsing a long list must not voice the whole catalog.
    expect(vi.mocked(ttsSpeak).mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("returns to idle when the sample finishes", async () => {
    voicePreview.toggle("af_heart");
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));
    ctx.started()[0].onended?.();
    expect(useVoicePreviewStore.getState().phase).toBe("idle");
    expect(useVoicePreviewStore.getState().voice).toBeNull();
  });
});
