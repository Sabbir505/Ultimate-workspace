// The barge-in decision gate is pure, so every transition is tested by
// feeding RMS numbers — no microphone, no audio graph. The design these
// encode was corrected against LIVE logs twice:
//
//  · calibrate on SOUNDING audio only — a window that runs while the engine
//    is still synthesizing measures silence and collapses the threshold, so
//    the gate then confirmed a barge-in on the TTS's own sound and cut the
//    read a few words in;
//  · ratchet the ceiling on loud-but-unsustained runs — echo varies passage
//    to passage, and each dead spike is a measurement of it.
import { beforeEach, describe, expect, it } from "vitest";
import { resetEchoCalibration, VoiceActivityGate } from "../lib/voiceActivity";

const QUIET = 0.004; // under every threshold in use here
const ECHO = 0.08; // the TTS as the mic hears it through speakers
const VOICE = 0.25; // a person talking at the microphone
const sound = true;
const silent = false;

/** Five sounding chunks — a full calibration window. */
function calibrate(gate: VoiceActivityGate, level = ECHO) {
  for (let i = 0; i < 5; i++) gate.feed(level, sound);
}

describe("VoiceActivityGate", () => {
  beforeEach(() => resetEchoCalibration());

  it("stays deaf until audio actually sounds, however long the synth takes", () => {
    const gate = new VoiceActivityGate();
    // The engine is synthesizing: the loop is "speaking" but nothing sounds.
    // These chunks must not consume the calibration window.
    for (let i = 0; i < 20; i++) gate.feed(ECHO, silent);
    expect(gate.threshold(silent)).toBe(Infinity);
    // Audio starts: only now does the window fill.
    calibrate(gate);
    expect(gate.threshold(sound)).toBeGreaterThan(ECHO);
  });

  it("arms above the measured bleed: the speakers cannot trigger their own death", () => {
    const gate = new VoiceActivityGate();
    calibrate(gate);
    // The same level that calibrated is now BELOW the voice threshold.
    for (let i = 0; i < 10; i++) expect(gate.feed(ECHO, sound)).toBeNull();
  });

  it("confirms sustained speech above the bleed and latches", () => {
    const gate = new VoiceActivityGate();
    calibrate(gate);
    expect(gate.feed(VOICE, sound)).toBeNull();
    expect(gate.feed(VOICE, sound)).toBeNull();
    expect(gate.feed(VOICE, sound)).toBe("confirm");
    expect(gate.feed(VOICE, sound)).toBeNull(); // latched until reset
  });

  it("resets its run on an intermittent quiet chunk", () => {
    const gate = new VoiceActivityGate();
    calibrate(gate);
    expect(gate.feed(VOICE, sound)).toBeNull();
    expect(gate.feed(QUIET, sound)).toBeNull();
    expect(gate.feed(VOICE, sound)).toBeNull();
    expect(gate.feed(VOICE, sound)).toBeNull();
    expect(gate.feed(VOICE, sound)).toBe("confirm");
  });

  it("a loud run that dies unsustained does NOT raise the ceiling (could be speech)", () => {
    const gate = new VoiceActivityGate();
    calibrate(gate, 0.03);
    const before = gate.threshold(sound);
    // A spike that dies before the confirm window is ambiguous — echo or a
    // real voice's inter-word dip. Folding it into the ceiling would deafen
    // the gate to the person, so the threshold must not move.
    gate.feed(0.2, sound);
    gate.feed(0.2, sound);
    gate.feed(QUIET, sound);
    expect(gate.threshold(sound)).toBe(before);
  });

  it("seeds the next episode from the measured ceiling — no deaf window twice", () => {
    const gate = new VoiceActivityGate();
    calibrate(gate, ECHO);
    gate.reset();
    // Fresh episode, same room: armed immediately, same threshold.
    expect(gate.threshold(sound)).toBeGreaterThan(ECHO);
    expect(gate.feed(VOICE, sound)).toBeNull();
    expect(gate.feed(VOICE, sound)).toBeNull();
    expect(gate.feed(VOICE, sound)).toBe("confirm");
  });

  it("hears a voice during a buffer gap, where no echo exists", () => {
    const gate = new VoiceActivityGate();
    calibrate(gate);
    // Between sentences the player parks on the engine: nothing sounding.
    // An echo tail below the floor threshold, then a quiet voice — the echo
    // ceiling does not apply when nothing is sounding, so the voice confirms.
    expect(gate.feed(0.01, silent)).toBeNull();
    expect(gate.feed(0.03, silent)).toBeNull();
    expect(gate.feed(0.03, silent)).toBeNull();
    expect(gate.feed(0.03, silent)).toBe("confirm");
  });

  it("adapts its floor down toward a quieter room (quiet chunks only)", () => {
    const gate = new VoiceActivityGate({ echoGuard: false, minThreshold: 0.008 });
    const start = gate.threshold(sound);
    for (let i = 0; i < 60; i++) gate.feed(0.001, sound);
    expect(gate.threshold(sound)).toBeLessThan(start);
  });

  it("never lets a loud chunk raise the floor behind itself", () => {
    const gate = new VoiceActivityGate({ echoGuard: false });
    const before = gate.threshold(sound);
    gate.feed(VOICE, sound); // loud — must not touch the floor
    expect(gate.threshold(sound)).toBe(before);
  });

  it("headphones: arms immediately on the plain noise floor", () => {
    const gate = new VoiceActivityGate({ echoGuard: false });
    expect(gate.threshold(sound)).not.toBe(Infinity);
    expect(gate.feed(VOICE, sound)).toBeNull();
    expect(gate.feed(VOICE, sound)).toBeNull();
    expect(gate.feed(VOICE, sound)).toBe("confirm");
  });

  it("clamps the initial floor to a usable range", () => {
    const low = new VoiceActivityGate({}, 0.00001);
    const high = new VoiceActivityGate({ echoGuard: false }, 0.5);
    expect(low.threshold(sound)).toBeGreaterThan(0);
    expect(high.threshold(sound)).toBeGreaterThanOrEqual(0.02 * 2.6);
  });
});
