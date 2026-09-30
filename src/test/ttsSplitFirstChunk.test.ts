// The CPU critical-path cap: the first spoken chunk must be short, or the
// listener waits out a full sentence of synthesis before a single word.
import { describe, expect, it } from "vitest";
import { splitFirstChunk, type SpeechChunk } from "../lib/tts";

const chunk = (text: string, paragraphStart = false): SpeechChunk => ({ text, paragraphStart });

describe("splitFirstChunk", () => {
  it("leaves short chunks untouched", () => {
    const chunks = [chunk("Short opener."), chunk("Second sentence.")];
    expect(splitFirstChunk(chunks, 110)).toEqual(chunks);
  });

  it("re-splits an over-long first chunk at a clause boundary", () => {
    const long =
      "This is a long opening thought, with a natural clause break right about here, and then it keeps going well past the cap so the wrap must cut it somewhere sensible for the listener.";
    const out = splitFirstChunk([chunk(long), chunk("Next.")], 110);
    // First piece short, all text preserved, the rest queued behind.
    expect(out[0].text.length).toBeLessThanOrEqual(110);
    expect(out.map((c) => c.text).join(" ")).toContain(long.slice(0, 60));
    expect(out[out.length - 1]?.text).toBe("Next.");
    expect(out.length).toBeGreaterThan(2);
  });

  it("keeps the paragraphStart flag on the new first piece", () => {
    const long = "A very long opening sentence that runs on and on and exceeds the cap length by a comfortable margin, yes.";
    const out = splitFirstChunk([chunk(long, true)], 110);
    expect(out[0].paragraphStart).toBe(true);
  });

  it("leaves the GPU path's chunks alone when already within the cap", () => {
    const single = [chunk("One sentence under the cap.")];
    expect(splitFirstChunk(single, 110)).toEqual(single);
  });

  it("returns the input unchanged for an empty queue", () => {
    expect(splitFirstChunk([], 110)).toEqual([]);
  });
});
