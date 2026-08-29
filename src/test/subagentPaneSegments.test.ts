// Pane-fidelity regression tests: the subagent pane must parse its stream
// into the SAME ordered segment stream as the chat view (text / think / tool
// in source order — the old parser returned separate text[] and rows[] lists
// and rendered every tool row above every text block), fold result markers
// into the preceding tool row, and keep edit-kind markers renderable as
// DiffCards (kind "edit" with path + edit payload).
import { describe, expect, it } from "vitest";
import { parseSubagentOutput } from "../components/panes/SubagentPanel";

const tool = (name: string, detail: string) =>
  `<tool>${JSON.stringify({ kind: "tool", title: name, detail })}</tool>`;
const result = (text: string) =>
  `<tool>${JSON.stringify({ kind: "result", title: "Output", result: text })}</tool>`;
const edit = (path: string) =>
  `<tool>${JSON.stringify({
    kind: "edit",
    title: `Editing file "${path}"`,
    detail: path,
    path,
    edit: { mode: "replace", find: "a", replace: "b" },
  })}</tool>`;

describe("parseSubagentOutput — ordered segments", () => {
  it("interleaves text, thinking and tool rows in source order", () => {
    const output = [
      "<think>Let me check the config first.</think>",
      "Checking the config.\n",
      tool("Reading file", "src/main.rs"),
      result("fn main() {}"),
      "Found the entry point.",
      tool("Searching code", "pattern"),
      result("2 hits"),
      "Final answer.",
    ].join("");
    const segs = parseSubagentOutput(output);
    expect(segs.map((s) => s.type)).toEqual([
      "think",
      "text",
      "tool",
      "text",
      "tool",
      "text",
    ]);
    const [think, text1, row1, text2, row2, text3] = segs;
    expect(think).toMatchObject({ type: "think", text: "Let me check the config first.", done: true });
    expect(text1).toMatchObject({ type: "text" });
    expect(row1.type === "tool" && row1.data?.title).toBe("Reading file");
    expect(row2.type === "tool" && row2.data?.detail).toBe("pattern");
    expect(text3).toMatchObject({ type: "text" });
  });

  it("folds result markers into the preceding tool row (spinner → done)", () => {
    const output = tool("Reading a web page", "example.com") + result("page text");
    const segs = parseSubagentOutput(output);
    expect(segs).toHaveLength(1);
    const row = segs[0];
    expect(row.type === "tool" && row.done).toBe(true);
    expect(row.type === "tool" && row.data?.result).toBe("page text");
  });

  it("keeps an announced tool row spinning until its result streams", () => {
    const output = tool("Reading file", "src/a.rs");
    const segs = parseSubagentOutput(output);
    expect(segs).toHaveLength(1);
    // The marker is fully closed but no result yet — still running.
    expect(segs[0].type === "tool" && segs[0].done).toBe(false);
  });

  it("keeps edit markers DiffCard-ready (kind edit with path + edit payload)", () => {
    const output = edit("src/app.ts") + result("");
    const segs = parseSubagentOutput(output);
    expect(segs).toHaveLength(1);
    const row = segs[0];
    expect(row.type === "tool" && row.data?.kind).toBe("edit");
    expect(row.type === "tool" && row.data?.path).toBe("src/app.ts");
    expect(row.type === "tool" && row.data?.edit).toBeDefined();
  });

  it("routes each result to its own row when tools run back-to-back", () => {
    const output = [
      tool("Reading file", "a.rs"),
      result("A"),
      tool("Reading file", "b.rs"),
      result("B"),
    ].join("");
    const segs = parseSubagentOutput(output);
    expect(segs).toHaveLength(2);
    expect(segs[0].type === "tool" && segs[0].data?.result).toBe("A");
    expect(segs[1].type === "tool" && segs[1].data?.result).toBe("B");
    for (const s of segs) expect(s.type === "tool" && s.done).toBe(true);
  });

  it("handles a mid-stream unterminated think block (live)", () => {
    const segs = parseSubagentOutput("<think>still reasoning");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ type: "think", done: false });
  });
});
