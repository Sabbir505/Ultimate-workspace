// The barge-in decision gate is pure, so every transition is tested by
// feeding RMS numbers — no microphone, no audio graph. The design these
// encode: calibrate on the playback's own echo (no pausing — the old
// pause-and-check chopped the read and eventually killed it on its own
// echo), then confirm sustained speech ABOVE the speaker bleed.
import { describe, expect, it } from "vitest";
import { VoiceActivityGate } from "../lib/voiceActivity";

const QUIET = 0.004; // under every threshold in use here
const ECHO = 0.08; // the TTS as the mic hears it through speakers
const VOICE = 0.25; // a person talking at the microphone

describe("VoiceActivityGate", () => {
  it("calibrates on the playback's own echo, deaf during calibration", () => {
    const gate = new VoiceActivityGate();
    // Five calibration chunks hear the speakers; nothing fires, ever.
    for (let i = 0; i < 5; i++) expect(gate.feed(ECHO)).toBeNull();
    // Armed: the same level that calibrated is now BELOW the voice
    // threshold — the speakers cannot trigger their own death.
    expect(gate.feed(ECHO)).toBeNull();
    expect(gate.feed(ECHO)).toBeNull();
    expect(gate.feed(ECHO)).toBeNull();
  });

  it("confirms sustained speech above the calibrated bleed", () => {
    const gate = new VoiceActivityGate();
    for (let i = 0; i < 5; i++) gate.feed(ECHO);
    expect(gate.feed(VOICE)).toBeNull(); // run 1 of 2
    expect(gate.feed(VOICE)).toBe("confirm");
    // Latched until reset — a barge-in is acted on exactly once.
    expect(gate.feed(VOICE)).toBeNull();
    gate.reset();
    // Fresh episode recalibrates (deaf again, then re-armed).
    expect(gate.threshold).toBe(Infinity);
    for (let i = 0; i < 5; i++) gate.feed(ECHO);
    expect(gate.feed(ECHO)).toBeNull();
  });

  it("resets its run on an intermittent quiet chunk", () => {
    const gate = new VoiceActivityGate();
    for (let i = 0; i < 5; i++) gate.feed(ECHO);
    expect(gate.feed(VOICE)).toBeNull();
    expect(gate.feed(QUIET)).toBeNull();
    expect(gate.feed(VOICE)).toBeNull(); // run restarted at 1
    expect(gate.feed(VOICE)).toBe("confirm");
  });

  it("adapts its floor down toward a quieter room (quiet chunks only)", () => {
    const gate = new VoiceActivityGate({ echoGuard: false, minThreshold: 0.008 });
    const start = gate.threshold;
    for (let i = 0; i < 60; i++) gate.feed(0.001);
    expect(gate.threshold).toBeLessThan(start);
  });

  it("never lets a loud chunk raise the floor behind itself", () => {
    const gate = new VoiceActivityGate({ echoGuard: false });
    const before = gate.threshold;
    gate.feed(VOICE); // loud — must not touch the floor
    expect(gate.threshold).toBe(before);
  });

  it("headphones: skips calibration and arms on the plain noise floor", () => {
    const gate = new VoiceActivityGate({ echoGuard: false });
    expect(gate.threshold).not.toBe(Infinity);
    // Room noise sits well under the floor-based threshold; a voice clears
    // it without any calibration window.
    expect(gate.feed(VOICE)).toBeNull();
    expect(gate.feed(VOICE)).toBe("confirm");
  });

  it("clamps the initial floor to a usable range", () => {
    const low = new VoiceActivityGate({}, 0.00001);
    const high = new VoiceActivityGate({ echoGuard: false }, 0.5);
    expect(low.threshold).toBeGreaterThan(0);
    expect(high.threshold).toBeGreaterThanOrEqual(0.02 * 2.6);
  });
});
