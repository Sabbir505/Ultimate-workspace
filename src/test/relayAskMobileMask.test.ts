import { describe, expect, it } from "vitest";
import { maskRelayAsk } from "../lib/segments";
import { maskRelayAsk as mobileMaskRelayAsk } from "../../mobile/src/lib/relayAsk";

// The phone carries its own copy of the mask (Metro can't reach outside
// mobile/). This suite pins the two implementations together: any drift in
// either direction fails the desktop gates, so the chat bubble can never
// regress into painting the raw RELAY_ASK JSON on one device only.
const VALID = `RELAY_ASK: {"question":"Proceed with the migration?","options":[{"label":"Yes"},{"label":"No"}]}`;

const CASES: [string, string][] = [
  ["no marker", "plain answer text"],
  ["empty", ""],
  ["marker mentioned in prose", "the RELAY_ASK: protocol is internal"],
  ["open-tail with partial json", `Working on it.\nRELAY_ASK: {"question":"Proc`],
  ["open-tail bare marker", "prefix\nRELAY_ASK:"],
  ["closed valid marker mid-reply", `Let me check first.\n${VALID}\nSome trailing prose.`],
  ["closed valid marker alone", VALID],
  ["closed marker with broken json", `text\nRELAY_ASK: {"question": oops\nafter`],
  ["open-tail payload without a question", `text\nRELAY_ASK: {"options":[]}`],
  ["closed payload without a question", `text\nRELAY_ASK: {"options":[]}\n`],
  ["backtick-wrapped json", `Hmm.\nRELAY_ASK: \`{"question":"Go?"}\``],
  ["two marker lines — last wins", `RELAY_ASK: {"question":"first"}\nmid\n${VALID}`],
  ["marker behind a tool marker", `<tool>{"kind":"read_file"}</tool>\nDone.\n${VALID}`],
  ["marker behind a closed think block", `\nAnswer.\n${VALID}`],
  ["indented marker", `Answer.\n   ${VALID}`],
];

describe("mobile maskRelayAsk — desktop parity", () => {
  it.each(CASES)("%s", (_name, input) => {
    expect(mobileMaskRelayAsk(input)).toBe(maskRelayAsk(input));
  });

  it("hides the streaming channel while the JSON is still arriving", () => {
    expect(mobileMaskRelayAsk("Working on it.\nRELAY_ASK: {\"question\":\"Proc")).toBe("Working on it.");
  });

  it("strips a finished marker line and keeps the prose around it", () => {
    expect(mobileMaskRelayAsk(`Let me check first.\n${VALID}\nSome trailing prose.`)).toBe(
      "Let me check first.\nSome trailing prose.",
    );
  });

  it("keeps a closed line whose payload is not a JSON object", () => {
    expect(mobileMaskRelayAsk("the RELAY_ASK: protocol is internal")).toBe(
      "the RELAY_ASK: protocol is internal",
    );
  });
});
