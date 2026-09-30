// The streaming feeder's contract: the OPENER voices the first words the
// moment enough text exists (mid-sentence, by design — time-to-first-audio is
// the point), think blocks and tool markers never voice, complete sentences
// only after that, and nothing is fed twice. These are unit tests because the
// failures are only audible mid-stream — a re-voiced sentence or a spelled-out
// tool call is obvious when listening.
import { describe, expect, it } from "vitest";
import { StreamingSpeechFeeder } from "../lib/ttsStream";

const text = (chunks: { text: string }[]) => chunks.map((c) => c.text);

describe("StreamingSpeechFeeder — opener (time-to-first-audio)", () => {
  it("voices the opening words mid-sentence as soon as there is enough text", () => {
    const feeder = new StreamingSpeechFeeder();
    const fed = feeder.push("The first sentence is done. The second is still being");
    // No full-sentence wait: the cut is at a boundary inside the growing
    // text, and the fragment starts sounding immediately.
    expect(fed.length).toBeGreaterThan(0);
    expect(fed[0].text.length).toBeGreaterThanOrEqual(24);
    expect(fed[0].text).toContain("The first sentence is done.");
  });

  it("prefers the latest clause boundary over a plain space", () => {
    const feeder = new StreamingSpeechFeeder();
    const fed = feeder.push("This is a longer opening clause, with a comma past the minimum.");
    expect(text(fed)[0]).toBe("This is a longer opening clause,");
  });

  it("waits while there is less than a couple of words to say", () => {
    const feeder = new StreamingSpeechFeeder();
    expect(feeder.push("Yes.")).toEqual([]);
    expect(feeder.push("Yes. I can")).toEqual([]);
  });

  it("keeps waiting when the only prose so far is inside think/tool blocks", () => {
    const feeder = new StreamingSpeechFeeder();
    expect(feeder.push("<think>lots of hidden reasoning here never to be voiced aloud</think>")).toEqual([]);
    expect(feeder.fedCount).toBe(0);
  });
});

describe("StreamingSpeechFeeder — steady state (after the opener)", () => {
  it("feeds the next sentence when its terminator lands, without re-feeding", () => {
    const feeder = new StreamingSpeechFeeder();
    feeder.push("Opening words get voiced right away, and then the tail keeps streaming");
    const before = feeder.fedCount;
    // The tail's remaining fragment grows without a terminator — nothing new.
    expect(feeder.push("Opening words get voiced right away, and then the tail keeps streaming more")).toEqual([]);
    expect(feeder.fedCount).toBe(before);
  });

  it("holds back the trailing fragment until its terminator arrives", () => {
    const feeder = new StreamingSpeechFeeder();
    feeder.push("Opener fragment cut at a boundary word");
    const fed = feeder.push("Opener fragment cut at a boundary word. A full sentence follows. A fra");
    expect(fed.map((c) => c.text)).toContain("A full sentence follows.");
    expect(fed.map((c) => c.text)).not.toContain("A fra");
  });

  it("flush voices the held-back tail at stream end — even right after the opener", () => {
    const feeder = new StreamingSpeechFeeder();
    // The opener lands on the final push of a short stream: flush must still
    // see the remainder (an empty tail here would drop it forever).
    feeder.push("Short but sufficient opener text, plus a tail fra");
    const tail = feeder.flush();
    expect(tail.length).toBeGreaterThan(0);
    expect(text(tail).join(" ")).toContain("tail fra");
  });

  it("never voices tool markers after the opener", () => {
    const feeder = new StreamingSpeechFeeder();
    feeder.push("Spoken intro sentence goes here. ");
    const fed = feeder.push(
      'Spoken intro sentence goes here. <tool>{"name":"bash","args":"ls"}</tool>The words after the tool',
    );
    expect(fed).toEqual([]);
    const done = feeder.push(
      'Spoken intro sentence goes here. <tool>{"name":"bash","args":"ls"}</tool>The words after the tool are safe.',
    );
    expect(text(done).join(" ")).toContain("The words after the tool are safe.");
  });
});
