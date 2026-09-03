// Render-level checks for the markdown UX round: generated tables (rounded
// wrapper + Copy/CSV toolbar + full-width fill), interactive citations
// resolved from a numbered "6. Source References" heading, and the
// single-$ math fix ("$5 and $10" must stay plain text with its spaces).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, render } from "@testing-library/react";
import { MessageBubble } from "../components/chat/MessageBubble";
import type { ChatMessage } from "../lib/ipc";

afterEach(() => cleanup());

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

describe("MessageBubble markdown UX", () => {
  it("wraps generated tables in the toolbar wrapper with Copy + CSV actions", () => {
    const content = [
      "| Property | Value |",
      "| --- | --- |",
      "| Context window | 200,000 tokens |",
      "| License | MIT |",
    ].join("\n");
    const { container, getByTitle } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );
    const wrap = container.querySelector(".chat-table-wrap");
    expect(wrap).not.toBeNull();
    // The table is a direct child and uses real table layout (fills width).
    expect(wrap!.querySelector("table")).not.toBeNull();
    expect(getByTitle("Copy table (pastes into spreadsheets as cells)")).toBeTruthy();
    expect(getByTitle("Download as CSV")).toBeTruthy();
  });

  it("turns [1] citations into chips when the message has a numbered Sources heading", () => {
    const content = [
      "The model ships with a 200K window [1] and step (1) stays plain.",
      "",
      "### 6. Source References",
      "1. Zhipu AI — GLM-5.3 Flash Official Model Guide https://z.ai/docs/guide/GLM-5.3-Flash",
    ].join("\n");
    const { container } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );
    // Only the resolved bracket citation becomes a chip; a single-number
    // parenthesized prose marker ("step (1)") deliberately stays plain text.
    const chips = container.querySelectorAll(".chat-citation");
    expect(chips.length).toBe(1);
    // Hover opens the source preview — rendered through a PORTAL at
    // document.body (fixed positioning escapes the transcript's stacking
    // contexts; see ChatCitation.tsx), so assert against document.body after
    // firing mouseenter. The 70ms open delay is bypassed by timers.
    vi.useFakeTimers();
    try {
      chips[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      act(() => {
        vi.advanceTimersByTime(120);
      });
      const tip = document.body.querySelector(".chat-citation-tip");
      expect(tip).not.toBeNull();
      expect(tip!.textContent).toContain("Zhipu AI");
      // Fixed layer, never absolutely-positioned inside the markdown flow.
      expect(tip!.classList.contains("chat-citation-tip")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps dollar amounts as plain text (no KaTeX space collapse)", () => {
    const content = 'He said "it costs $5 and $10 total".';
    const { container } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$5 and $10 total");
  });
});
