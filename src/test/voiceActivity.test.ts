// The barge-in decision gate is pure, so every transition is tested by
// feeding RMS numbers — no microphone, no audio graph.
import { describe, expect, it } from "vitest";
import { VoiceActivityGate } from "../lib/voiceActivity";

const QUIET = 0.004; // under every threshold in use here
const LOUD = 0.08; // a clear voice

describe("VoiceActivityGate", () => {
  it("stays silent in a quiet room", () => {
    const gate = new VoiceActivityGate();
    for (let i = 0; i < 40; i++) expect(gate.feed(QUIET)).toBeNull();
    expect(gate.holdingPause).toBe(false);
  });

  it("adapts its threshold down toward a quieter room (quiet chunks only)", () => {
    const gate = new VoiceActivityGate({ minThreshold: 0.008 });
    const start = gate.threshold;
    for (let i = 0; i < 60; i++) gate.feed(0.001);
    expect(gate.threshold).toBeLessThan(start);
  });

  it("never lets a loud chunk raise the floor behind itself", () => {
    const gate = new VoiceActivityGate({ minThreshold: 0.008 });
    const before = gate.threshold;
    gate.feed(0.5); // loud — must not touch the floor
    expect(gate.threshold).toBe(before);
  });

  it("clamps the initial floor to a usable range", () => {
    const low = new VoiceActivityGate({}, 0.00001);
    const high = new VoiceActivityGate({}, 0.5);
    expect(low.threshold).toBeGreaterThan(0);
    expect(high.threshold).toBeGreaterThanOrEqual(0.02 * 2.6);
  });

  describe("echo guard (speakers) — pause and check", () => {
    it("suspects on the first spike, then clears when it was echo", () => {
      const gate = new VoiceActivityGate();
      for (let i = 0; i < 10; i++) expect(gate.feed(QUIET)).toBeNull();
      expect(gate.feed(LOUD)).toBe("suspect");
      expect(gate.holdingPause).toBe(true);
      // Playback paused, the room went quiet: it was the speakers.
      expect(gate.feed(QUIET)).toBe("clear");
      expect(gate.holdingPause).toBe(false);
    });

    it("confirms when energy persists with playback paused", () => {
      const gate = new VoiceActivityGate();
      expect(gate.feed(LOUD)).toBe("suspect");
      expect(gate.feed(LOUD)).toBe("confirm");
      // Latched: nothing more until the caller resets after acting.
      expect(gate.feed(LOUD)).toBeNull();
      gate.reset();
      expect(gate.feed(LOUD)).toBe("suspect");
    });
  });

  describe("guard off (headphones) — sustained energy confirms", () => {
    it("confirms after the configured run without a suspect round-trip", () => {
      const gate = new VoiceActivityGate({ echoGuard: false });
      expect(gate.feed(LOUD)).toBeNull(); // run 1 of 2
      expect(gate.feed(LOUD)).toBe("confirm");
    });

    it("resets its run on an intermittent quiet chunk", () => {
      const gate = new VoiceActivityGate({ echoGuard: false });
      expect(gate.feed(LOUD)).toBeNull();
      expect(gate.feed(QUIET)).toBeNull();
      expect(gate.feed(LOUD)).toBeNull(); // run restarted at 1
      expect(gate.feed(LOUD)).toBe("confirm");
    });
  });
});
