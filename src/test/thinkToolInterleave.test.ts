// A tool call must never render as reasoning text. The backend wraps reasoning
// in `<think>…</think>` and tool calls in `<tool>{json}</tool>`, and the parser
// treats an UNTERMINATED think as swallowing the rest of the buffer — so a
// marker nested inside one paints as the thinking block's text. That is the
// "tool call stuck in the thinking block, then snapping into a tool row once
// the call finishes" report: the call itself runs fine (driven by the
// structured event), only its markup is mis-nested.
//
// Whole objects are compared rather than reading fields off the Segment
// union — `expect(segs[0].data)` doesn't narrow the type, so tsc rejects it.
import { describe, expect, it } from "vitest";

import { parseSegments } from "../lib/segments";

const tool = (title: string) => `<tool>{"kind":"tool","title":"${title}"}</tool>`;

describe("think/tool interleaving", () => {
  it("keeps a tool marker out of a still-open thinking block", () => {
    // The exact shape a handler emits when a call lands between two text
    // deltas: reasoning opens, the tool marker arrives, the close hasn't.
    const segs = parseSegments(`<think>weighing the options${tool("Read file")}`);

    // The think segment ends at the marker and holds only the reasoning. The
    // call that follows proves the reasoning is over, so it reports done —
    // it must not sit there labelled live "Thinking…".
    expect(segs).toEqual([
      { type: "think", text: "weighing the options", done: true },
      { type: "tool", data: { kind: "tool", title: "Read file" }, done: true },
    ]);
  });

  it("still parses normally when the think block closes before the tool", () => {
    const segs = parseSegments(`<think>reasoning</think>${tool("Read file")}done`);

    expect(segs).toEqual([
      { type: "think", text: "reasoning", done: true },
      { type: "tool", data: { kind: "tool", title: "Read file" }, done: true },
      { type: "text", text: "done" },
    ]);
  });

  it("does not split reasoning that merely mentions a <tool> marker", () => {
    // No JSON payload after the opener, so it is prose, not a real marker —
    // splitting here would cut a sentence in half mid-stream.
    const body = "the harness emits a <tool> marker per call, which I parse";
    const segs = parseSegments(`<think>${body}</think>`);

    expect(segs).toEqual([{ type: "think", text: body, done: true }]);
  });

  it("keeps a second tool marker out of the first tool's body", () => {
    // The pre-existing back-to-back guard: parallel subagent fan-out opens
    // several markers before any closes.
    const segs = parseSegments(`<tool>{"title":"A"}<tool>{"title":"B"}</tool>`);

    expect(segs).toEqual([
      { type: "tool", data: { title: "A" }, done: false },
      { type: "tool", data: { title: "B" }, done: true },
    ]);
  });

  it("recovers when the thinking block closes late (the re-parse users saw)", () => {
    // The same turn once the missing </think> finally arrives: the tool must
    // now be a normal tool segment, and that orphaned close must not surface
    // as literal text.
    const segs = parseSegments(`<think>reasoning${tool("Read file")}</think>after`);

    expect(segs).toEqual([
      { type: "think", text: "reasoning", done: true },
      { type: "tool", data: { kind: "tool", title: "Read file" }, done: true },
      { type: "text", text: "after" },
    ]);
  });
});
