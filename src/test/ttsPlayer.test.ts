// Read-aloud playback: synthesis order, the lookahead rule, and the transport
// buttons. Audible failures are what these encode — a heading that plays into
// silence, an engine asked twice for the same sentence, a Pause that never
// reaches the store's "paused" phase (which also made Resume unreachable).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({ ttsStatus: vi.fn(), ttsSpeak: vi.fn() }));
vi.mock("../lib/sound", () => ({ sharedAudioContext: vi.fn() }));

import { ttsSpeak, ttsStatus, type TtsAudio, type TtsStatus } from "../lib/ipc";
import { sharedAudioContext } from "../lib/sound";
import { ttsPlayer } from "../lib/tts";
import { useTtsStore } from "../state/tts";

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  /** The offset `start()` was given, or null while the source is unstarted. */
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
    // The mocked engine encodes each sentence's length in the payload, so a
    // test can decide how long a sentence "plays" for.
    return Promise.resolve({ duration: buf.byteLength / 1000, sampleRate: 24000 });
  }
  started() {
    return this.sources.filter((s) => s.startedWith !== null);
  }
}

let ctx: FakeCtx;
/** text → milliseconds of audio; texts not listed play for 1s. */
let durations: Map<string, number>;
/** text → a held reply the test resolves by hand (else the reply is immediate). */
let gates: Map<string, { promise: Promise<TtsAudio>; resolve: (a: TtsAudio) => void }>;
let calls: string[];

const audio = (ms: number): TtsAudio => ({
  audioBase64: btoa("\0".repeat(ms)),
  mime: "audio/wav",
  sampleRate: 24000,
  durationSec: ms / 1000,
  cached: false,
  voice: "v",
});

/** Hold a sentence's reply so a test can decide when the engine finishes it. */
function gate(text: string) {
  let resolve!: (a: TtsAudio) => void;
  const promise = new Promise<TtsAudio>((r) => (resolve = r));
  gates.set(text, { promise, resolve });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  ttsPlayer.stop();
  useTtsStore.setState({ key: null, label: null, index: 0, total: 0, error: null, phase: "idle" });
  vi.clearAllMocks();
  ctx = new FakeCtx();
  durations = new Map();
  gates = new Map();
  calls = [];
  vi.mocked(sharedAudioContext).mockReturnValue(ctx as unknown as AudioContext);
  vi.mocked(ttsStatus).mockResolvedValue({
    modelId: "test-model",
    voice: "vf",
    speed: 1,
    device: "cpu",
    voices: [],
  } as unknown as TtsStatus);
  vi.mocked(ttsSpeak).mockImplementation((text: string) => {
    calls.push(text);
    const held = gates.get(text);
    if (held) return held.promise;
    return Promise.resolve(audio(durations.get(text) ?? 1000));
  });
});

describe("synthesis order", () => {
  it("asks for the sentence being played before the lookahead", async () => {
    const text = "First sentence here. Second sentence here.";
    durations.set("First sentence here.", 2000);
    durations.set("Second sentence here.", 2000);

    void ttsPlayer.play({ key: "k", text });
    await tick();

    // The engine voices one chunk at a time, so the request order IS the
    // playback order. Prefetching ahead of the current sentence put the audio
    // the user was waiting for at the back of the queue.
    expect(calls[0]).toBe("First sentence here.");
    expect(calls).toContain("Second sentence here.");
  });
});

// Synthesis runs at ~1.5x realtime, so the queue is the only thing standing
// between a read and silence: these pin the buffering policy. A first read of a
// text builds a lead and then runs; the same text replayed is served from the
// engine's cache and never waits, which is exactly the difference users notice.
describe("lead", () => {
  it("builds the lead before the first word, one sentence at a time", async () => {
    const heading = "Numbers.";
    const para = "word ".repeat(40).trim(); // 199 chars ≈ 8.3s of synthesis
    durations.set(heading, 1000);
    durations.set(para, 8000);
    gate(heading);
    gate(para);

    void ttsPlayer.play({ key: "k", text: `${heading}\n\n${para}` });
    await tick();
    expect(calls).toEqual([heading]);

    gates.get(heading)!.resolve(audio(1000));
    await tick();
    // The next sentence is already being fetched...
    expect(calls).toContain(para);
    // ...and the heading is NOT sounding yet: one second of speech followed by
    // silence is the hole the lead exists to prevent.
    expect(ctx.started()).toHaveLength(0);
    // The wait is reported rather than disguised as playback.
    expect(useTtsStore.getState().phase).toBe("buffering");

    gates.get(para)!.resolve(audio(8000));
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));
    expect(ctx.started()[0].buffer?.duration).toBe(1);
    expect(useTtsStore.getState().phase).toBe("playing");
  });

  it("starts straight away when the first sentence is itself a long lead", async () => {
    const first = "A long opening sentence that fills the whole lead by itself.";
    const second = "Another sentence follows it.";
    durations.set(first, 12000);
    durations.set(second, 2000);
    gate(second); // the follow-up is still being voiced

    void ttsPlayer.play({ key: "k3", text: `${first} ${second}` });
    // 12s of audio ahead is the lead met — no reason to wait for a sentence
    // that this one already covers.
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));
    expect(ctx.started()[0].buffer?.duration).toBe(12);
  });

  it("does not stop at every sentence boundary once the lead is built", async () => {
    const a = "Alpha line.";
    const b = "Bravo line.";
    const c = "Charlie line.";
    durations.set(a, 1000);
    durations.set(b, 1000);
    durations.set(c, 1000);

    void ttsPlayer.play({ key: "k4", text: `${a} ${b} ${c}` });
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));

    // Walk the read: each sentence hands over to the next without the queue
    // being refilled to the full lead — a topping-up rule would pause here and
    // turn a list into a stutter.
    for (const expected of [2, 3]) {
      ctx.sources[ctx.started().length - 1].onended?.();
      await vi.waitFor(() => expect(ctx.started()).toHaveLength(expected));
    }
    expect(ctx.started().map((s) => s.buffer?.duration)).toEqual([1, 1, 1]);
  });

  it("asks the engine for each sentence once, even when the wait needs it", async () => {
    const heading = "Steady on.";
    // Its own wording: the player caches decoded audio per sentence for the life
    // of the module, so a shared text would be served from cache rather than
    // through the engine this test is counting.
    const para = "alpha ".repeat(40).trim();
    durations.set(heading, 1000);
    durations.set(para, 8000);
    gate(heading);

    void ttsPlayer.play({ key: "k2", text: `${heading}\n\n${para}` });
    await tick();
    gates.get(heading)!.resolve(audio(1000));

    // The lead waits on a sentence the prefetch already requested; a second
    // request for the same text would queue behind everything else and stretch
    // the stall it was meant to cover.
    await vi.waitFor(() => expect(calls).toContain(para));
    expect(calls.filter((c) => c === para)).toHaveLength(1);
  });
});

// The engine is kept busy on the text AFTER the playhead: a paragraph being
// listened to is exactly when the next paragraphs should be getting voiced,
// rather than the reader arriving at a sentence nobody has started yet.
describe("background pipeline", () => {
  it("voices the rest of the queue while the first sentence is still reading", async () => {
    const parts = ["Alpha one.", "Bravo two.", "Charlie three.", "Delta four."];
    for (const p of parts) durations.set(p, 5000);

    void ttsPlayer.play({ key: "kp", text: parts.join(" ") });
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));

    // Still on sentence one (nothing has ended), yet everything after it is
    // already voiced — and no playback waited on the engine to get there.
    await vi.waitFor(() => expect(calls).toEqual(expect.arrayContaining(parts)));
    expect(useTtsStore.getState().index).toBe(1);
    expect(ctx.started()).toHaveLength(1);
  });

  it("walks to the end of the text rather than stopping a fixed distance ahead", async () => {
    // 10 sentences x 5s = 50s of audio. Capping the walk at "a couple of
    // paragraphs" left the engine idle whenever the chunk being played was
    // longer than the cap — on GPU that is every chunk — and the read then
    // stopped at the next boundary while a cold call started up.
    const parts = Array.from({ length: 10 }, (_, i) => `Item number ${i + 1} here.`);
    for (const p of parts) durations.set(p, 5000);

    void ttsPlayer.play({ key: "kq", text: parts.join(" ") });
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));
    // Still reading sentence one; every later sentence is already voiced.
    await vi.waitFor(() => expect(calls).toHaveLength(parts.length));
    expect(ctx.started()).toHaveLength(1);
  });

  it("stops walking when the read is stopped", async () => {
    const parts = Array.from({ length: 6 }, (_, i) => `Stop left ${i + 1} here.`);
    for (const p of parts) durations.set(p, 5000);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = () => r()));
    vi.mocked(ttsSpeak).mockImplementation((text: string) => {
      calls.push(text);
      // Holding BOTH in-flight slots is what parks the walk — with only one
      // held, each landing request frees a slot and the walk keeps going, which
      // is the whole point of it.
      if (parts[1] === text || parts[2] === text) return held.then(() => audio(5000));
      return Promise.resolve(audio(durations.get(text) ?? 1000));
    });

    void ttsPlayer.play({ key: "kz", text: parts.join(" ") });
    await vi.waitFor(() => expect(calls).toContain(parts[2]));
    ttsPlayer.stop();
    release();
    await tick();
    await tick();
    // The read is over: nothing past what was already in flight is requested,
    // so a stopped read is not still grinding through the artifact.
    expect(calls).not.toContain(parts[3]);
  });
});

// GPU synthesis is a child process per call: ~4.5s of startup before a single
// word is voiced. Sentence-per-call spent that on every couple of seconds of
// audio, so playback ran dry between sentences and the bar sat in "Buffering…"
// — the whole reason the chunk budget exists.
describe("gpu chunking", () => {
  const text = Array.from({ length: 8 }, (_, i) => `Sentence number${i + 1} here.`).join(" ");

  it("fills one call with many sentences", async () => {
    vi.mocked(ttsStatus).mockResolvedValue({
      modelId: "test-model",
      voice: "vf",
      speed: 1,
      device: "gpu",
      voices: [],
    } as unknown as TtsStatus);

    void ttsPlayer.play({ key: "kg", text });
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Sentence number8 here.");
    expect(calls[0].length).toBeLessThanOrEqual(1100);
  });

  it("keeps the first call small so the first word is not stuck behind a paragraph", async () => {
    vi.mocked(ttsStatus).mockResolvedValue({
      modelId: "test-model",
      voice: "vf",
      speed: 1,
      device: "gpu",
      voices: [],
    } as unknown as TtsStatus);
    // One long paragraph: grouped by the full budget this is a single
    // paragraph-sized call, and the listener waits for every word of it before
    // the first one is audible.
    const text = Array.from({ length: 14 }, (_, i) => `Sentence number${i + 1} here.`).join(" ");

    void ttsPlayer.play({ key: "kw", text });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0].length).toBeLessThanOrEqual(260);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("keeps sentence-sized calls on CPU, where a call is free", async () => {
    void ttsPlayer.play({ key: "kc8", text });
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));
    expect(calls.length).toBeGreaterThan(1);
  });
});

describe("transport buttons", () => {
  const text = "One two. Three four. Five six.";
  const chunks = ["One two.", "Three four.", "Five six."];

  async function playThree() {
    durations.set(chunks[0], 3000);
    durations.set(chunks[1], 4000);
    durations.set(chunks[2], 5000);
    void ttsPlayer.play({ key: "kb", text });
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));
  }

  it("Next jumps to the following sentence", async () => {
    await playThree();
    expect(ctx.started()[0].buffer?.duration).toBe(3);

    ttsPlayer.next();
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(2));
    expect(ctx.started()[1].buffer?.duration).toBe(4);
    expect(useTtsStore.getState().index).toBe(2);
  });

  it("Prev goes back a sentence", async () => {
    await playThree();
    ttsPlayer.next();
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(2));

    ttsPlayer.prev();
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(3));
    expect(ctx.started()[2].buffer?.duration).toBe(3);
    expect(useTtsStore.getState().index).toBe(1);
  });

  it("Pause reports the paused phase and Resume picks up where it stopped", async () => {
    await playThree();

    ctx.currentTime = 1.5; // 1.5s into the first sentence
    ttsPlayer.pause();
    // Before the fix the pump never heard back from the stopped source, so the
    // store stayed "playing" and Resume refused to run.
    expect(useTtsStore.getState().phase).toBe("paused");
    expect(ctx.started()[0].stopped).toBe(true);

    ttsPlayer.resume();
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(2));
    expect(ctx.started()[1].startedWith).toBeCloseTo(1.5, 5);
  });

  it("takes a Pause that lands while the queue is being refilled", async () => {
    const a = "A long first sentence that satisfies the lead on its own.";
    const b = "Bravo here.";
    const c = "charlie ".repeat(30).trim(); // 209 chars ≈ 8.7s of synthesis
    durations.set(a, 12000);
    durations.set(b, 1000);
    durations.set(c, 8000);
    gate(c); // the sentence after the short one is still being voiced
    void ttsPlayer.play({ key: "kc", text: `${a} ${b} ${c}` });
    await vi.waitFor(() => expect(ctx.started()).toHaveLength(1));

    // First sentence finishes: the second is short enough that the queue behind
    // it is empty, so the read parks on the engine mid-fetch.
    ctx.sources[0].onended?.();
    await vi.waitFor(() => expect(useTtsStore.getState().phase).toBe("buffering"));
    expect(ctx.started()).toHaveLength(1);

    // Nothing is sounding, so this click has no source to stop. It must still
    // land — otherwise Pause looks dead for the whole wait, and the sentence
    // being fetched goes on to play anyway.
    ttsPlayer.pause();
    expect(useTtsStore.getState().phase).toBe("paused");

    gates.get(c)!.resolve(audio(8000));
    await tick();
    await tick();
    expect(ctx.started()).toHaveLength(1);
  });

  it("Stop returns the bar to idle and silences the read", async () => {
    await playThree();
    ttsPlayer.stop();
    expect(useTtsStore.getState().phase).toBe("idle");
    expect(useTtsStore.getState().key).toBeNull();
    expect(ctx.started()[0].stopped).toBe(true);
  });
});
