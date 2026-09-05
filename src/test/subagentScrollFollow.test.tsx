// C8 (ISSUES.md): SubagentPanel force-scrolled to the bottom after EVERY
// render, pinning anyone who scrolled up to re-read the streamed output.
// The tail-follow must only engage when the user is already near the bottom
// (<80px), and must leave a scrolled-up viewport alone.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SubagentPanel } from "../components/panes/SubagentPanel";
import { useChatStore } from "../state/chat";
import { useUiStore } from "../state/ui";

function subagentsWith(output: string) {
  return {
    "sess-1": {
      sub1: {
        id: "sub1",
        role: "researcher",
        task: "dig into it",
        status: "running" as const,
        prompt: "go dig",
        output,
      },
    },
  };
}

beforeEach(() => {
  useChatStore.setState({
    activeChatSessionId: "sess-1",
    subagents: subagentsWith("first chunk of output") as never,
  });
  useUiStore.setState({ activeSubagentId: "sub1" });
});

afterEach(() => {
  cleanup();
  useChatStore.setState({ activeChatSessionId: null, subagents: {} });
  useUiStore.setState({ activeSubagentId: null });
});

function mountPanel() {
  return render(<SubagentPanel />);
}

function bodyOf(container: HTMLElement): HTMLElement {
  const panel = container.querySelector(".subagent-panel-body") as HTMLElement;
  // jsdom does no layout — pin the geometry the effect measures.
  Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(panel, "clientHeight", { configurable: true, value: 500 });
  return panel;
}

describe("SubagentPanel tail-follow (C8)", () => {
  it("preserves the scroll position of a user who scrolled up", () => {
    const { container, rerender } = mountPanel();
    const panel = bodyOf(container);

    // The user scrolled up to re-read: 2000 - 300 - 500 = 1200px from bottom.
    // (Max scrollTop is 1500 = 2000 - 500, so 300 is well away from the tail.)
    panel.scrollTop = 300;
    // More tokens stream in → re-render.
    act(() => {
      useChatStore.setState({ subagents: subagentsWith("first chunk\nsecond chunk") as never });
    });
    rerender(<SubagentPanel />);

    expect(panel.scrollTop).toBe(300);
  });

  it("still follows the tail when the user is near the bottom", () => {
    const { container, rerender } = mountPanel();
    const panel = bodyOf(container);

    // Near the bottom: 2000 - 1450 - 500 = 50px < 80px.
    panel.scrollTop = 1450;
    act(() => {
      useChatStore.setState({ subagents: subagentsWith("first chunk\nmore tokens") as never });
    });
    rerender(<SubagentPanel />);

    expect(panel.scrollTop).toBe(2000);
  });
});
