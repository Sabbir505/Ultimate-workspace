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

function Harness({
  messages,
  showTranscript = true,
}: {
  messages: unknown;
  showTranscript?: boolean;
}) {
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
  // Mirrors ChatView's conditional render: the transcript div is absent until
  // the buffer has something in it.
  if (!showTranscript) return <div data-testid="welcome" />;
  return (
    <div
      data-testid="transcript"
      ref={scroll.messagesContainerCallbackRef}
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

  it("binds the input listeners when the transcript mounts AFTER the hook", () => {
    // The regression this whole file is about. ChatView renders the transcript
    // CONDITIONALLY (`!activeChatSessionId || hasItems ? <div …/> :
    // <ChatWelcome/>`), and on a fresh ChatView the buffer is empty — so the
    // div does not exist when the hook's effects first run. The listeners used
    // to be attached by an effect with `[]` deps that read the ref and bailed
    // on null, so they NEVER bound for the rest of that ChatView's life: the
    // wheel-up was swallowed by the pin-suppression window and the view was
    // yanked back — the exact symptom the listeners were added to prevent.
    const { rerender } = render(<Harness messages={[]} showTranscript={false} />);
    expect(document.querySelector('[data-testid="transcript"]')).toBeNull();

    // The welcome screen gives way to the transcript (first message arrives).
    rerender(<Harness messages={["first"]} showTranscript />);
    const el = geometry();
    el.scrollTop = 1500;

    act(() => {
      fireEvent.wheel(el, { deltaY: -120 });
    });

    expect(latch().current).toBe(false);
  });

  it("ignores a wheel gesture an inner scroller consumes", () => {
    // The transcript embeds its own scrollers (the expanded thinking body, the
    // compacted-turns list). Wheeling inside one doesn't move the transcript,
    // so it must not count as leaving the live edge — otherwise reading back
    // through a thinking block silently kills follow and pops the
    // "Jump to latest" pill while the viewport is still on the newest message.
    render(<Harness messages={["first"]} />);
    const el = geometry();
    el.scrollTop = 1500;
    const inner = document.createElement("div");
    inner.className = "chat-thinking-body";
    // jsdom does no layout, so make the inner box genuinely scrollable and
    // give it the overflow the real rule sets.
    Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(inner, "clientHeight", { configurable: true, value: 250 });
    inner.style.overflowY = "auto";
    // The user has scrolled down inside it and keeps reading upward.
    inner.scrollTop = 300;
    el.appendChild(inner);

    act(() => {
      fireEvent.wheel(inner, { deltaY: -120 });
    });

    // Still following — the transcript never moved.
    expect(latch().current).toBe(true);
  });

  it("counts a wheel an inner scroller has already exhausted", () => {
    // The other half: once the inner scroller is at its top, the overflow
    // chains to the transcript, which DOES move. That is a real scroll of the
    // live edge and must break the latch like any other.
    render(<Harness messages={["first"]} />);
    const el = geometry();
    el.scrollTop = 1500;
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(inner, "clientHeight", { configurable: true, value: 250 });
    inner.scrollTop = 0; // at the top — nothing left to consume
    el.appendChild(inner);

    act(() => {
      fireEvent.wheel(inner, { deltaY: -120 });
    });

    expect(latch().current).toBe(false);
  });

  it("breaks the latch on a scrollbar drag (pointerdown, no wheel)", () => {    render(<Harness messages={["first"]} />);
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
