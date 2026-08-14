// Regression tests for code-point-safe slicing: raw String.slice splits
// surrogate pairs (emoji, CJK ext-B, …) at the cut, leaving a lone surrogate
// that renders as U+FFFD — and, for persisted values like chat titles,
// corrupts them permanently.
import { describe, expect, it } from "vitest";
import { sliceCodePoints, tailCodePoints } from "../lib/safeSlice";
import { generateSessionTitle } from "../lib/sessionTitle";

const isLoneSurrogate = (s: string) =>
  // Any unpaired high or low surrogate in the string.
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("sliceCodePoints", () => {
  it("never splits a surrogate pair at the cut", () => {
    const s = "a".repeat(39) + "🎉🎉🎉";
    // Unit 40 is the HIGH half of the first 🎉 — it must be dropped whole.
    const out = sliceCodePoints(s, 40);
    expect(out).toBe("a".repeat(39));
    expect(isLoneSurrogate(out)).toBe(false);
  });

  it("passes BMP strings through unchanged", () => {
    expect(sliceCodePoints("héllo wörld", 5)).toBe("héllo");
  });

  it("returns full string when shorter than max", () => {
    expect(sliceCodePoints("short", 40)).toBe("short");
  });

  it("handles max <= 0", () => {
    expect(sliceCodePoints("anything", 0)).toBe("");
  });
});

describe("tailCodePoints", () => {
  it("never splits a surrogate pair at the cut", () => {
    // Tail window starting exactly at the low half of 🎉 must drop it.
    const s = "a".repeat(200_000) + "🎉tail";
    const out = tailCodePoints(s, 200_002);
    expect(isLoneSurrogate(out)).toBe(false);
    expect(out.endsWith("🎉tail")).toBe(true);
  });

  it("keeps the tail intact for BMP strings", () => {
    expect(tailCodePoints("0123456789", 4)).toBe("6789");
  });

  it("returns full string when shorter than max", () => {
    expect(tailCodePoints("short", 10)).toBe("short");
  });
});

describe("generateSessionTitle emoji safety", () => {
  it("does not persist a split surrogate in the title", () => {
    const prompt = "x".repeat(20) + " 🎉🎉🎉 some long prompt that exceeds the cap";
    const title = generateSessionTitle(prompt);
    expect(title).not.toBeNull();
    expect(isLoneSurrogate(title!)).toBe(false);
  });
});
