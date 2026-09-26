// Streaming typewriter caret on the live assistant bubble.
//
// The caret itself is a CSS ::after (see chat.css) — the bubble body is
// arbitrary react-markdown output, so the trailing character is a text node
// buried in whatever element the parser produced this token, and it MOVES as
// mid-stream markdown reshuffles. Anchoring to the last rendered BLOCK is
// stable and costs the markdown pipeline nothing. What is testable here is the
// gate: which bubbles get the class that turns the caret on.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MessageBubble } from "../components/chat/MessageBubble";
import type { ChatMessage } from "../lib/ipc";

afterEach(() => cleanup());

function msg(role: "user" | "assistant", content: string): ChatMessage {
  return {
    id: 1,
    chatSessionId: "s1",
    role,
    content,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt: 0,
  } as ChatMessage;
}

const bubbleOf = (container: HTMLElement) =>
  container.querySelector(".chat-bubble") as HTMLElement;

describe("streaming caret gate", () => {
  it("is on for a live assistant turn that has produced text", () => {
    const { container } = render(
      <MessageBubble message={msg("assistant", "Working on it")} chatSessionId="s1" live />,
    );
    expect(bubbleOf(container).classList.contains("streaming")).toBe(true);
  });

  it("is off once the turn ends", () => {
    const { container } = render(
      <MessageBubble message={msg("assistant", "All done.")} chatSessionId="s1" />,
    );
    expect(bubbleOf(container).classList.contains("streaming")).toBe(false);
  });

  it("is off for a user bubble even if `live` is somehow set", () => {
    const { container } = render(
      <MessageBubble message={msg("user", "hello")} chatSessionId="s1" live />,
    );
    expect(bubbleOf(container).classList.contains("streaming")).toBe(false);
  });

  it("is off before the first token — TypingIndicator owns that moment", () => {
    // `live` is true from the moment the turn STARTS: the store pre-creates the
    // streaming buffer as "". A caret here would be a second, redundant
    // indicator stacked on the pre-token "thinking" animation.
    const { container } = render(
      <MessageBubble message={msg("assistant", "")} chatSessionId="s1" live />,
    );
    expect(bubbleOf(container).classList.contains("streaming")).toBe(false);
  });

  it("is off for a whitespace-only buffer (nothing to sit after)", () => {
    const { container } = render(
      <MessageBubble message={msg("assistant", "   \n  ")} chatSessionId="s1" live />,
    );
    expect(bubbleOf(container).classList.contains("streaming")).toBe(false);
  });

  it("keeps the caret target anchored to the last rendered markdown block", () => {
    // The CSS is `… > .chat-markdown:last-child`, so the markdown container
    // must be a DIRECT child of .chat-bubble-inner with no wrapper div in
    // between — otherwise the selector silently matches nothing and the caret
    // never appears at all.
    const { container } = render(
      <MessageBubble message={msg("assistant", "first para\n\nsecond para")} chatSessionId="s1" live />,
    );
    const inner = container.querySelector(".chat-bubble-inner") as HTMLElement;
    const md = inner.querySelector(":scope > .chat-markdown");
    expect(md).not.toBeNull();
    const lastEl = inner.lastElementChild as HTMLElement;
    expect(lastEl.classList.contains("chat-markdown")).toBe(true);
    // …and it has block children for the ::after to attach to.
    expect(md!.lastElementChild).not.toBeNull();
  });
});
