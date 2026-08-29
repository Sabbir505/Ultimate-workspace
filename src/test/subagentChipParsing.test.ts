// Regression tests for the inline subagent chips (MessageBubble). The
// parallel fan-out pre-pass emits every Task's `<tool>` opener BACK-TO-BACK
// before any closing tag streams in — the old parser swallowed the whole run
// into one unparseable inner blob and rendered a single phantom "working…"
// row instead of one chip per subagent (user-visible in the chat view while
// the git sidebar AGENTS list showed the agents).
import { describe, expect, it } from "vitest";
import { parseSegments } from "../components/chat/MessageBubble";

function taskMarker(task: string): string {
  return `<tool>${JSON.stringify({
    kind: "subagent",
    title: "SubAgent",
    role: "research",
    task,
    prompt: `deep prompt for ${task}`,
  })}`;
}

describe("parseSegments — parallel subagent fan-out", () => {
  it("parses stacked open markers as one live chip per subagent", () => {
    const live =
      "text before" + taskMarker("A") + taskMarker("B") + taskMarker("C");
    const segs = parseSegments(live);
    const tools = segs.filter((s) => s.type === "tool");
    expect(segs[0].type).toBe("text");
    expect(tools).toHaveLength(3);
    const tasks = tools.map((s) =>
      s.type === "tool" && s.data ? s.data.task : null,
    );
    expect(tasks).toEqual(["A", "B", "C"]);
    // No closing tag streamed yet → every chip is still running.
    for (const s of tools) expect(s.done).toBe(false);
    // The marker JSON must parse (no phantom data-null "working…" row).
    for (const s of tools) {
      expect(s.type === "tool" && s.data?.kind).toBe("subagent");
    }
  });

  it("pairs closes correctly once results stream in (mixed open/closed)", () => {
    const content =
      taskMarker("A") + "</tool>" + taskMarker("B") + taskMarker("C");
    const segs = parseSegments(content);
    const tools = segs.filter((s) => s.type === "tool");
    expect(tools).toHaveLength(3);
    expect(tools[0].done).toBe(true);
    expect(tools[1].done).toBe(false);
    expect(tools[2].done).toBe(false);
  });

  it("keeps fully closed markers done and preserves sanitized content", () => {
    // The backend neutralizes literal structural tags inside marker content
    // (<tool> → <\tool>, serde-escaped) — the opener split must not false-hit
    // on the escaped form.
    const inner = JSON.stringify({
      kind: "code",
      title: "Running code",
      code: "x <\\tool> y",
    });
    const segs = parseSegments(`<tool>${inner}</tool>tail`);
    expect(segs).toHaveLength(2);
    const tool = segs[0];
    expect(tool.type).toBe("tool");
    if (tool.type === "tool") {
      expect(tool.done).toBe(true);
      expect(tool.data?.kind).toBe("code");
    }
    expect(segs[1]).toEqual({ type: "text", text: "tail" });
  });

  it("still splits <think> blocks the old way (no opener splitting)", () => {
    const content = "<think>reasoning</think>answer";
    const segs = parseSegments(content);
    expect(segs).toEqual([
      { type: "think", text: "reasoning", done: true },
      { type: "text", text: "answer" },
    ]);
  });
});
