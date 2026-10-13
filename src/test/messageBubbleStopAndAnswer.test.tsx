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
import { flushLazy } from "./flushLazy";

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
  it("interleaves narration with tool rows; the trailing answer stays visible collapsed", async () => {
    const content = [
      tool("Reading a web page", "rust-lang.org/learn"),
      "\n\n## Analysis\n\nRust is a systems language with strong guarantees.",
      tool("Reading a web page", "blog.rust-lang.org"),
      "\n\nClosing note.",
    ].join("");
    const { queryByText, container } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );
    await flushLazy();

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

  it("keeps the final answer visible when interleaved thinking precedes it", async () => {
    const content = [
      "<think>Considering the options.</think>",
      "\n\nFirst conclusion stands on its own.",
      "<think>One more consideration.</think>",
      "\n\nFinal answer.",
    ].join("");
    const { queryByText, container } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );
    await flushLazy();
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

describe("MessageBubble visualization placement", () => {
  const vizMarker = (detail: string) =>
    `<tool>${JSON.stringify({
      kind: "viz-data",
      title: "Visualizing",
      detail,
      viz: "chart",
      payload: { title: "Deploys by week", bars: [{ label: "W1", value: 4 }, { label: "W2", value: 9 }] },
    })}</tool>`;

  it("keeps a mid-turn card in place and names it in the collapsed summary", async () => {
    // VIZ_COMPOSITION_AND_PLACEMENT.md §2 (the rule change): a card the model
    // emitted and then KEPT WORKING after is mid-turn work — it renders in
    // place, inside the process region, between the tool rows around it. The
    // card is named in the collapsed row, which is what keeps an in-region
    // card discoverable now that hoisting is no longer unconditional.
    const content =
      vizMarker("Deploys") + tool("Searching the web", "follow-up probe") + "\n\nBoth cards are above.";
    const { container } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );
    await flushLazy();
    // Collapsed, the region body isn't mounted — the summary chip is the
    // discovery path, so it must carry the card's title.
    const toggle = container.querySelector(".chat-process-toggle")!;
    expect(toggle.textContent).toContain("Deploys");
    fireEvent.click(toggle);
    await flushLazy();
    const card = container.querySelector('[data-testid="viz-card-chart"]');
    expect(card).toBeTruthy();
    // In place: inside the region, alongside the LATER tool row…
    expect(card!.closest(".chat-process")).toBeTruthy();
    const region = container.querySelector(".chat-process")!;
    expect(region.textContent).toContain("follow-up probe");
    // …while the trailing prose is the answer and stays outside it.
    expect(region.textContent).not.toContain("Both cards are above.");
  });

  it("hoists a card with no later call into the answer area", async () => {
    // The other half of the rule, unchanged: a card with nothing after it is
    // the turn's RESULT and must never be swallowed by the collapsed region.
    const content = tool("Searching the web", "probe") + vizMarker("Deploys") + "\n\nCard above.";
    const { container } = render(
      <MessageBubble message={assistantMsg(content)} chatSessionId="s1" />,
    );
    await flushLazy();
    const card = container.querySelector('[data-testid="viz-card-chart"]');
    expect(card).toBeTruthy();
    // Outside the collapsible, and a real card (not the unavailable fallback).
    expect(card!.closest(".chat-process")).toBeNull();
    expect(card!.closest(".chat-viz-card")).toBeTruthy();
  });
});
