// Regression tests for two assistant-turn rendering contracts:
//
// 1. STOPPED TURNS stay expanded: a turn the user stopped (state/chat.ts
//    cancelStream records its trimmed partial in `stoppedPartial`) keeps its
//    process section open and reads "Stopped" — collapsing it produced an
//    empty-looking "Worked" row that hid the only content the turn produced.
//    Completed turns (no stoppedPartial match) keep collapsing by default.
//
// 2. ANSWER PROSE STAYS OUTSIDE the process region: the old partition folded
//    "everything up to the LAST process block" into the collapsed summary, so
//    an answer paragraph followed by one more tool/think vanished into it.
//    Every text block after the FIRST process block must render as visible
//    markdown below the summary, expanded or not.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MessageBubble } from "../components/chat/MessageBubble";
import { useChatStore } from "../state/chat";
import type { ChatMessage } from "../lib/ipc";

function assistantMsg(content: string): ChatMessage {
  return {
    id: 1,
    chatSessionId: "s1",
    role: "assistant",
    content,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt: 0,
  } as ChatMessage;
}

function tool(title: string, detail = "", kind = "web"): string {
  const obj: Record<string, string> = { kind, title };
  if (detail) obj.detail = detail;
  return `<tool>${JSON.stringify(obj)}</tool>`;
}

afterEach(() => {
  cleanup();
  useChatStore.setState({ stoppedPartial: {} });
});

describe("MessageBubble stopped turns", () => {
  it("keeps a stopped turn's process section expanded and labels it Stopped", () => {
    const content = tool("Searching the web", "solana validators");
    useChatStore.setState({ stoppedPartial: { s1: content } });
    const { queryByText, container } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );

    // Expanded at mount: the step's specific detail is visible without any
    // click, and the label reads "Stopped" instead of "Worked".
    expect(queryByText(/solana validators/)).not.toBeNull();
    const label = container.querySelector(".chat-process-label");
    expect(label?.textContent).toBe("Stopped");
  });

  it("still collapses completed turns that don't match the stop marker", () => {
    const content = tool("Searching the web", "solana validators");
    useChatStore.setState({ stoppedPartial: { s1: "some other turn's partial" } });
    const { queryByText } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );
    expect(queryByText(/solana validators/)).toBeNull();
  });
});

describe("MessageBubble answer visibility", () => {
  it("keeps answer prose visible when a tool call follows it", () => {
    const content = [
      tool("Reading a web page", "rust-lang.org/learn"),
      "\n\n## Analysis\n\nRust is a systems language with strong guarantees.",
      tool("Reading a web page", "blog.rust-lang.org"),
      "\n\nClosing note.",
    ].join("");
    const { queryByText, container } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );

    // The prose BETWEEN the two tool calls must render outside the collapsed
    // process region — the old "up to the last process block" rule hid it.
    expect(queryByText(/strong guarantees/)).not.toBeNull();
    expect(queryByText(/Closing note/)).not.toBeNull();
    // Exactly one process summary still wraps the turn's activity.
    expect(container.querySelectorAll(".chat-process-toggle").length).toBe(1);
  });

  it("keeps answer prose visible when interleaved thinking follows it", () => {
    const content = [
      "<think>Considering the options.</think>",
      "\n\nFirst conclusion stands on its own.",
      "<think>One more consideration.</think>",
      "\n\nFinal answer.",
    ].join("");
    const { queryByText } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );
    // No tool calls at all — a think/text interleave. Both prose blocks stay
    // visible; only the reasoning collapses into the process row.
    expect(queryByText(/First conclusion stands/)).not.toBeNull();
    expect(queryByText(/Final answer/)).not.toBeNull();
  });
});
