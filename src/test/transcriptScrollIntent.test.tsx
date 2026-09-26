// The chat transcript's follow latch must yield to real user input. During a
// stream the pin pass writes scrollTop on every token, so the 120ms
// programmatic-pin suppression window is nearly always open — a wheel-up that
// landed inside it was discarded, the latch stayed set, and the next token
// yanked the view back to the live edge ("can't scroll up while streaming").
// Input listeners run BEFORE that scroll event, so the latch is off in time.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useTranscriptScroll } from "../components/chat/useTranscriptScroll";

function Harness({ messages }: { messages: unknown }) {
  const scroll = useTranscriptScroll({
    activeChatSessionId: "sess-1",
    hasMoreHistory: false,
    loadOlder: async () => undefined,
    messages,
    streaming: true,
    approvalKey: null,
    questionKey: null,
  });
  useEffect(() => {
    // Expose the refs the assertions read.
    (globalThis as never as { __scroll: unknown }).__scroll = scroll;
  }, [scroll]);
  return (
    <div
      data-testid="transcript"
      ref={scroll.messagesContainerRef}
      onScroll={scroll.handleScroll}
    />
  );
}

afterEach(cleanup);

/** jsdom does no layout — pin the geometry the hook measures. */
function geometry(): HTMLElement {
  const el = document.querySelector('[data-testid="transcript"]') as HTMLElement;
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });
  return el;
}

function latch(): { current: boolean } {
  return (globalThis as never as { __scroll: { stickToBottomRef: { current: boolean } } })
    .__scroll.stickToBottomRef;
}

describe("transcript follow latch vs. user input", () => {
  it("breaks the latch on a wheel-up so streaming can't drag the view back", () => {
    render(<Harness messages={["first"]} />);
    const el = geometry();
    el.scrollTop = 1500; // at the live edge

    act(() => {
      fireEvent.wheel(el, { deltaY: -120 });
    });

    expect(latch().current).toBe(false);
  });

  it("breaks the latch on a scrollbar drag (pointerdown, no wheel)", () => {
    render(<Harness messages={["first"]} />);
    const el = geometry();
    el.scrollTop = 1500;

    act(() => {
      fireEvent.pointerDown(el);
    });
    act(() => {
      el.scrollTop = 900;
      fireEvent.scroll(el);
    });

    // 2000 - 900 - 500 = 600px from the bottom — well outside the 80px latch.
    expect(latch().current).toBe(false);
  });

  it("keeps following when the user scrolls back down", () => {
    render(<Harness messages={["first"]} />);
    const el = geometry();

    act(() => {
      fireEvent.wheel(el, { deltaY: -120 });
    });
    expect(latch().current).toBe(false);

    // Scrolling back to within 80px of the bottom re-arms the follow.
    act(() => {
      el.scrollTop = 1500;
      fireEvent.scroll(el);
    });

    expect(latch().current).toBe(true);
  });

  it("does not break the latch on a wheel-down mid-stream", () => {
    render(<Harness messages={["first"]} />);
    const el = geometry();
    el.scrollTop = 1500;

    act(() => {
      fireEvent.wheel(el, { deltaY: 120 });
    });

    expect(latch().current).toBe(true);
  });
});
