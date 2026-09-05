// A5 (ISSUES.md): onToken/onSubagentTokens re-sliced the streaming buffer via
// `tailCodePoints(prev + token, 200_000)` — once the cap was reached, EVERY
// incoming token copied the full ~200K-char string (O(buffer) per token).
// The fix adds `tailCodePointsHysteresis`: re-slice only when the buffer
// exceeds cap+margin, trimming back to cap−margin, so per-token cost drops to
// O(token) while the buffer stays bounded.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { tailCodePoints, tailCodePointsHysteresis } from "../lib/safeSlice";
import { useChatStore } from "../state/chat";

const CAP = 200_000;
const MARGIN = 10_000;
const isLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("tailCodePointsHysteresis", () => {
  it("returns the input untouched while inside the cap+margin band", () => {
    const s = "a".repeat(CAP + MARGIN);
    expect(tailCodePointsHysteresis(s, CAP, MARGIN)).toBe(s);
  });

  it("trims back BELOW the cap once the band is exceeded", () => {
    const s = "a".repeat(CAP + MARGIN + 1);
    const out = tailCodePointsHysteresis(s, CAP, MARGIN);
    expect(out.length).toBe(CAP - MARGIN); // 190K — room to grow again
    expect(out.endsWith("a")).toBe(true);
  });

  it("never exceeds cap+margin over a long token stream", () => {
    let buf = "";
    for (let i = 0; i < 500; i++) {
      buf = tailCodePointsHysteresis(buf + "x".repeat(1000), CAP, MARGIN);
      expect(buf.length).toBeLessThanOrEqual(CAP + MARGIN);
    }
  });

  it("never splits a surrogate pair at the trim point", () => {
    const s = "a".repeat(CAP + MARGIN) + "🎉🎉";
    const out = tailCodePointsHysteresis(s, CAP, MARGIN);
    expect(isLoneSurrogate(out)).toBe(false);
  });

  it("degrades to the plain tail cap when margin <= 0", () => {
    expect(tailCodePointsHysteresis("0123456789", 4, 0)).toBe(tailCodePoints("0123456789", 4));
    expect(tailCodePointsHysteresis("", 10, 0)).toBe("");
  });
});

describe("A5: per-token slice cost past the cap (slice-op counting)", () => {
  let sliceSpy: MockInstance<(start?: number, end?: number) => string>;

  beforeEach(() => {
    sliceSpy = vi.spyOn(String.prototype, "slice");
  });
  afterEach(() => {
    sliceSpy.mockRestore();
  });

  it("stops re-slicing on every token once inside the hysteresis band", () => {
    // Drive the buffer past cap+margin with 1K tokens (trim fires at 211K).
    let buf = "";
    for (let i = 0; i < 211; i++) buf = tailCodePointsHysteresis(buf + "x".repeat(1000), CAP, MARGIN);
    expect(buf.length).toBe(CAP - MARGIN);
    const slicesAtTrim = sliceSpy.mock.calls.length;

    // 15 further tokens inside the band (20K of headroom): hysteresis must
    // NOT slice again — the old per-token cap re-sliced 200K chars on every
    // single one.
    for (let i = 0; i < 15; i++) buf = tailCodePointsHysteresis(buf + "x".repeat(1000), CAP, MARGIN);
    expect(buf.length).toBe(CAP - MARGIN + 15_000);
    expect(sliceSpy.mock.calls.length).toBe(slicesAtTrim);

    // Exceed cap+margin again → trims back below the cap (205K + 6K crosses
    // the 210K trigger, so the final token lands trimmed at 190K).
    for (let i = 0; i < 6; i++) buf = tailCodePointsHysteresis(buf + "x".repeat(1000), CAP, MARGIN);
    expect(buf.length).toBe(CAP - MARGIN);
    expect(sliceSpy.mock.calls.length).toBeGreaterThan(slicesAtTrim);
  });

  it("the chat store's onToken uses the hysteresis cap", () => {
    useChatStore.setState({ streaming: { s1: "" }, streamingChatSessionId: "s1" });
    for (let i = 0; i < 211; i++) useChatStore.getState().onToken("s1", "x".repeat(1000));
    // First trim fired at cap+margin: the buffer is back at cap−margin.
    expect(useChatStore.getState().streaming.s1!.length).toBe(CAP - MARGIN);
    // A few more tokens grow it again without trims — still bounded.
    useChatStore.getState().onToken("s1", "y".repeat(5000));
    const len = useChatStore.getState().streaming.s1!.length;
    expect(len).toBe(CAP - MARGIN + 5000);
    expect(len).toBeLessThanOrEqual(CAP + MARGIN);
  });
});
