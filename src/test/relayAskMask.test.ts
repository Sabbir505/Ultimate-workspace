import { describe, expect, it } from "vitest";
import { maskRelayAsk, parseSegments } from "../lib/segments";

const VALID = `RELAY_ASK: {"question":"Proceed with the migration?","options":[{"label":"Yes"},{"label":"No"}]}`;

describe("maskRelayAsk", () => {
  it("returns content unchanged when no marker is present", () => {
    expect(maskRelayAsk("plain answer text")).toBe("plain answer text");
    expect(maskRelayAsk("")).toBe("");
    // Mentions of the marker without a following JSON line must not hide text.
    expect(maskRelayAsk("the RELAY_ASK: protocol is internal")).toBe(
      "the RELAY_ASK: protocol is internal",
    );
  });

  it("hides a still-streaming marker line (open tail)", () => {
    expect(maskRelayAsk("Working on it.\nRELAY_ASK: {\"question\":\"Proc")).toBe("Working on it.");
    expect(maskRelayAsk("prefix\nRELAY_ASK:")).toBe("prefix");
  });

  it("strips a closed marker line whose JSON parses, keeping prose after it", () => {
    expect(maskRelayAsk(`Let me check first.\n${VALID}\nSome trailing prose.`)).toBe(
      "Let me check first.\nSome trailing prose.",
    );
    // Marker as the whole reply.
    expect(maskRelayAsk(VALID)).toBe("");
  });

  it("keeps a closed marker line whose JSON does not parse", () => {
    const broken = 'RELAY_ASK: {"question": oops';
    expect(maskRelayAsk(`text\n${broken}\nafter`)).toBe(`text\n${broken}\nafter`);
  });

  it("hides an open-tail JSON line even without a question (still streaming)", () => {
    const noQ = 'RELAY_ASK: {"options":[]}';
    expect(maskRelayAsk(`text\n${noQ}`)).toBe("text");
    // Closed variant (trailing newline) follows the backend's keep rule.
    expect(maskRelayAsk(`text\n${noQ}\n`)).toBe("text");
  });

  it("tolerates backtick-wrapped JSON like the backend", () => {
    const wrapped = "RELAY_ASK: `{\"question\":\"Go?\"}`";
    expect(maskRelayAsk(`Hmm.\n${wrapped}`)).toBe("Hmm.");
  });

  it("hides only the LAST marker line", () => {
    const first = 'RELAY_ASK: {"question":"first"}';
    expect(maskRelayAsk(`${first}\nmid\n${VALID}`)).toBe(`${first}\nmid`);
  });
});

describe("parseSegments RELAY_ASK integration", () => {
  it("never surfaces the directive as a text segment", () => {
    const segs = parseSegments(`Answer part one.\n${VALID}`);
    const texts = segs.filter((s) => s.type === "text").map((s) => s.text);
    expect(texts.join("")).not.toContain("RELAY_ASK");
    expect(texts.join("")).toContain("Answer part one.");
  });
});
