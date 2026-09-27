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

  it("does not split reasoning that QUOTES the marker format", () => {
    // Regression: the old guard only required a `{` after the opener, which
    // prose about the marker format satisfies. The split then left the rest of
    // the sentence in a tool segment with no `</tool>` ahead of it, so
    // `JSON.parse` failed and the parse loop broke on `end === -1` — every
    // remaining token of the reply was DROPPED and replaced by a phantom tool
    // row that spins forever. Permanent, too: it re-breaks on every re-render
    // and after a restart, because it is a pure function of the stored text.
    const body =
      'the <tool>{"kind":"tool"} marker is how a call is announced, ' +
      "so the parser splits on the opener";
    const segs = parseSegments(`<think>${body}</think>Here is the answer.`);

    // The whole reasoning block survives intact, and so does the reply text
    // after it — nothing is swallowed.
    expect(segs).toEqual([
      { type: "think", text: body, done: true },
      { type: "text", text: "Here is the answer." },
    ]);
  });

  it("never loses the tail when reasoning quotes a complete marker", () => {
    // A fully-formed `<tool>{valid json}</tool>` in prose is genuinely
    // indistinguishable from a real one, so it does split — and the tag the
    // model wrote stays visible as its own text, which is faithful. What must
    // hold is the invariant the guard establishes: every split produces a
    // PARSEABLE tool segment, so the loop always makes progress.
    //
    // The old code could split on prose that was NOT a marker, leaving a tool
    // segment with no `</tool>` ahead of it — `end === -1` — which dropped
    // every remaining token of the reply and left a phantom row spinning
    // forever. Assert the content survives and nothing renders unterminated.
    const segs = parseSegments(
      '<think>the wire format is <tool>{"kind":"x"}</tool> exactly</think>Visible tail.',
    );

    const rendered = segs
      .map((s) => (s.type === "text" ? s.text : s.type === "think" ? s.text : ""))
      .join("");
    expect(rendered).toContain("Visible tail.");
    expect(rendered).toContain("the wire format is");
    // Nothing left spinning: every non-text segment is terminated, so none of
    // them renders as a live "Thinking…"/"working…" row.
    for (const s of segs) {
      if (s.type !== "text") expect(s.done).toBe(true);
    }
  });

  it("drops the orphaned </think> that trails a split marker", () => {
    // The real close arrives after the marker we split on, so it is orphaned.
    // It must not surface as literal text — with or without a space between
    // it and the marker's own close, which is how prose usually writes it.
    for (const spacer of ["", " "]) {
      const segs = parseSegments(
        `<think>reasoning${tool("Read file")}${spacer}</think>tail`,
      );
      // Only the trailing text survives — no literal `</think>`, and no
      // leftover whitespace from the stripped orphan.
      expect(segs.filter((s) => s.type === "text").map((s) => s.text)).toEqual(["tail"]);
    }
  });

  it("splits only on a marker that parses as a JSON object", () => {
    // The flip side of the guard above: a real marker nested in an open think
    // still has to split, or the call renders as reasoning text.
    const segs = parseSegments(`<think>weighing it${tool("Read file")}</think>tail`);

    expect(segs).toEqual([
      { type: "think", text: "weighing it", done: true },
      { type: "tool", data: { kind: "tool", title: "Read file" }, done: true },
      { type: "text", text: "tail" },
    ]);
  });

  it("does not split on a half-streamed marker payload", () => {
    // Markers are emitted atomically, so a `{`-prefix that is not yet a
    // complete object is not a marker yet — treat it as prose until it is.
    const segs = parseSegments(`<think>still streaming <tool>{"kind":"to`);

    expect(segs).toEqual([{ type: "think", text: "still streaming <tool>{\"kind\":\"to", done: false }]);
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
