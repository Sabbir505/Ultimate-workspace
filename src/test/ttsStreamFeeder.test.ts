// The streaming feeder's contract: only COMPLETE sentences leave, think
// blocks and tool markup never voice, and nothing is fed twice. These are
// unit tests because the failures are only audible mid-stream — a re-voiced
// sentence or a spelled-out tool call is obvious when listening.
import { describe, expect, it } from "vitest";
import { StreamingSpeechFeeder } from "../lib/ttsStream";

describe("StreamingSpeechFeeder", () => {
  it("holds back the trailing fragment until its terminator arrives", () => {
    const feeder = new StreamingSpeechFeeder();
    const first = feeder.push("The first sentence is done. The second is still be");
    expect(first.map((c) => c.text)).toEqual(["The first sentence is done."]);
    // More of the same sentence streams — still nothing new.
    const mid = feeder.push("The first sentence is done. The second is still being written");
    expect(mid).toEqual([]);
    const done = feeder.push("The first sentence is done. The second is still being written now.");
    expect(done.map((c) => c.text)).toEqual([
      "The second is still being written now.",
    ]);
  });

  it("flush voices the held-back tail at stream end", () => {
    const feeder = new StreamingSpeechFeeder();
    feeder.push("One complete sentence. And a trailing fra");
    const tail = feeder.flush();
    expect(tail.map((c) => c.text).join(" ")).toContain("And a trailing fra");
  });

  it("never voices think blocks or tool markers — open or closed", () => {
    const feeder = new StreamingSpeechFeeder();
    // An open <think> swallows everything after it until it closes.
    const a = feeder.push("Spoken intro. <think>reasoning that must stay silent");
    expect(a.map((c) => c.text)).toEqual(["Spoken intro."]);
    const b = feeder.push(
      "Spoken intro. <think>silent reasoning</think><tool>{\"name\":\"bash\"}</tool>After the tool,",
    );
    expect(b).toEqual([]);
    const c = feeder.push(
      'Spoken intro. <think>silent reasoning</think><tool>{"name":"bash"}</tool>After the tool, the answer continues here.',
    );
    expect(c.map((c) => c.text)).toEqual(["After the tool, the answer continues here."]);
  });

  it("feeds nothing for a stream that never produces prose", () => {
    const feeder = new StreamingSpeechFeeder();
    expect(feeder.push("<think>all reasoning</think>")).toEqual([]);
    expect(feeder.flush()).toEqual([]);
    expect(feeder.fedCount).toBe(0);
  });

  it("does not re-feed across pushes when earlier sentences persist", () => {
    const feeder = new StreamingSpeechFeeder();
    const text = "Alpha ends here. Beta ends here. Gamma has no end ye";
    feeder.push(text);
    const again = feeder.push(text);
    expect(again).toEqual([]);
    expect(feeder.fedCount).toBe(2);
  });

  it("counts fed chunks so the caller can tell voiced from silent turns", () => {
    const feeder = new StreamingSpeechFeeder();
    feeder.push("One. Two. Three bytes of tail");
    expect(feeder.fedCount).toBe(2);
    feeder.flush();
    expect(feeder.fedCount).toBe(3);
  });
});
