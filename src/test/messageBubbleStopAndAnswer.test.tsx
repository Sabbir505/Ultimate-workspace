// Regression tests for two assistant-turn rendering contracts:
//
// 1. STOPPED TURNS stay expanded: a turn the user stopped (state/chat.ts
//    cancelStream records its trimmed partial in `stoppedPartial`) keeps its
//    process section open and reads "Stopped" — collapsing it produced an
//    empty-looking "Worked" row that hid the only content the turn produced.
//    Completed turns (no stoppedPartial match) keep collapsing by default.
//
// 2. CHRONOLOGICAL PROCESS TRANSCRIPT: the process region holds every block
//    up to the LAST process block IN SOURCE ORDER — tool rows, thinking, AND
//    the narration written between tool runs — so an expanded turn reads in
//    sequence instead of "all tools up top, all prose below" (the old
//    "text after the FIRST process block renders outside" rule). Only the
//    trailing text AFTER the last process block — the synthesized answer —
//    renders outside the collapsible, so it stays visible when the region is
//    collapsed.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
  it("interleaves narration with tool rows; the trailing answer stays visible collapsed", () => {
    const content = [
      tool("Reading a web page", "rust-lang.org/learn"),
      "\n\n## Analysis\n\nRust is a systems language with strong guarantees.",
      tool("Reading a web page", "blog.rust-lang.org"),
      "\n\nClosing note.",
    ].join("");
    const { queryByText, container } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );

    // Collapsed: the mid-turn narration ("Analysis") hides WITH the process
    // region it belongs to; the trailing answer stays visible.
    expect(queryByText(/strong guarantees/)).toBeNull();
    expect(queryByText(/Closing note/)).not.toBeNull();
    // Exactly one process summary still wraps the turn's activity.
    expect(container.querySelectorAll(".chat-process-toggle").length).toBe(1);
    // Expanded: the narration is part of the region again, in source order.
    fireEvent.click(container.querySelector(".chat-process-toggle")!);
    expect(queryByText(/strong guarantees/)).not.toBeNull();
  });

  it("keeps the final answer visible when interleaved thinking precedes it", () => {
    const content = [
      "<think>Considering the options.</think>",
      "\n\nFirst conclusion stands on its own.",
      "<think>One more consideration.</think>",
      "\n\nFinal answer.",
    ].join("");
    const { queryByText, container } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );
    // Collapsed: the prose BETWEEN the thinking blocks belongs to the process
    // transcript; the final answer stays outside and visible.
    expect(queryByText(/First conclusion stands/)).toBeNull();
    expect(queryByText(/Final answer/)).not.toBeNull();
    // Expanded: the interleaved prose renders with the reasoning.
    fireEvent.click(container.querySelector(".chat-process-toggle")!);
    expect(queryByText(/First conclusion stands/)).not.toBeNull();
    expect(queryByText(/Final answer/)).not.toBeNull();
  });
});
