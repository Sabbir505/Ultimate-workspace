// Tests the collapsed activity-summary grouping in MessageBubble: a
// multi-tool run renders as ONE collapsed summary line by default (not N
// flat rows), per-step labels are content-specific, the trailing answer
// renders OUTSIDE the collapsed group, and narration between calls folds
// into the group rather than floating between rows.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MessageBubble } from "../components/chat/MessageBubble";
import type { ChatMessage } from "../lib/ipc";

// react-markdown/syntax-highlighter are heavy and not under test; render real
// MessageBubble but assert only on structural text/toggles, not markdown HTML.

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

afterEach(() => cleanup());

describe("MessageBubble activity grouping", () => {
  it("collapses a multi-tool run into one summary line, not per-call rows", () => {
    const content = [
      tool("Reading a web page", "rust-lang.org/learn"),
      "Let me check another source.",
      tool("Reading a web page", "doc.rust-lang.org/book"),
      "\n\nBased on these, Rust is a systems language.",
    ].join("");
    const { queryByText, getByRole } = render(
      <MessageBubble message={assistantMsg(content)} />,
    );

    // The generic per-call title must NOT appear as loose rows by default —
    // only the synthesized summary and the final answer render.
    expect(queryByText("Reading a web page — rust-lang.org/learn")).toBeNull();
    // The trailing synthesized answer renders outside the collapsed group.
    expect(queryByText(/systems language/)).not.toBeNull();

    // Exactly one activity toggle in the bubble.
    const toggles = document.body.querySelectorAll(".chat-activity-toggle");
    expect(toggles.length).toBe(1);
  });

  it("reveals content-specific step labels only after expanding the group", () => {
    const content = [
      tool("Reading a web page", "rust-lang.org/learn"),
      tool("Searching the web", "rust async runtime"),
      "\n\nDone.",
    ].join("");
    const { queryByText, container } = render(
      <MessageBubble message={assistantMsg(content)} />,
    );

    // Before expand: specific labels hidden.
    expect(queryByText(/rust-lang\.org\/learn/)).toBeNull();
    expect(queryByText(/async runtime/)).toBeNull();

    // Expand the group: click the activity toggle (the synthesized summary).
    const toggle = container.querySelector(".chat-activity-toggle") as HTMLElement;
    fireEvent.click(toggle);

    // After expand: both specific step labels now visible.
    expect(queryByText(/rust-lang\.org\/learn/)).not.toBeNull();
    expect(queryByText(/async runtime/)).not.toBeNull();
  });

  it("renders a single lone tool call as a collapsed group too", () => {
    const content = tool("Searching the web", "solana validators");
    const { queryByText } = render(
      <MessageBubble message={assistantMsg(content)} />,
    );
    // Collapsed by default — the specific query is hidden until expanded.
    expect(queryByText(/solana validators/)).toBeNull();
  });

  it("folds thinking between tool calls into the SAME group, not separate blocks", () => {
    const content = [
      tool("Searching the web", "rust async runtime"),
      "<think>I should verify this on the official site.</think>",
      tool("Reading a web page", "rust-lang.org"),
      "\n\nFinal answer.",
    ].join("");
    const { container, queryByText } = render(
      <MessageBubble message={assistantMsg(content)} />,
    );

    // Exactly ONE outer container for the whole turn — no standalone
    // ThinkingBlock, no second activity block.
    expect(container.querySelectorAll(".chat-activity-toggle").length).toBe(1);
    expect(container.querySelectorAll(".chat-thinking-toggle").length).toBe(0);
    // Trailing answer still renders outside the group.
    expect(queryByText(/Final answer/)).not.toBeNull();

    // Expanding the outer row reveals the nested thinking block inside.
    const toggle = container.querySelector(".chat-activity-toggle") as HTMLElement;
    fireEvent.click(toggle);
    const nested = container.querySelectorAll(".chat-activity-steps .chat-thinking-toggle");
    expect(nested.length).toBe(1);
  });

  it("folds a leading think before the first tool into the group", () => {
    const content = [
      "<think>Let me plan this search.</think>",
      tool("Searching the web", "tokio tutorial"),
      "\n\nDone.",
    ].join("");
    const { container } = render(
      <MessageBubble message={assistantMsg(content)} />,
    );
    expect(container.querySelectorAll(".chat-activity-toggle").length).toBe(1);
    expect(container.querySelectorAll(".chat-thinking-toggle").length).toBe(0);
  });

  it("keeps a think-only turn as a standalone ThinkingBlock (no group)", () => {
    const content = "<think>Reasoning only, no tools.</think>\n\nAnswer.";
    const { container } = render(
      <MessageBubble message={assistantMsg(content)} />,
    );
    expect(container.querySelectorAll(".chat-activity-toggle").length).toBe(0);
    expect(container.querySelectorAll(".chat-thinking-toggle").length).toBe(1);
  });
});
