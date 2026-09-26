// Clicking a tick on the turn rail must actually move the transcript.
//
// The bug: the jump went through the virtualizer's SMOOTH scrollToIndex, which
// is inert on this scroll element — measured in the real ChatView, an instant
// `scrollToIndex(0, {align:'start'})` moved the transcript (scrollTop 168.8 →
// 0) while `scrollToIndex(0, {behavior:'smooth'})` left it at 168.8, so every
// click landed nowhere and the rail looked dead. A native smooth `scrollTo` on
// the same element animates fine, which is what the fix drives.
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTranscriptScroll } from "../components/chat/useTranscriptScroll";
import { scrollToChatMessage } from "../lib/chatScroll";

// Mutable shapes: the hook's refs are `RefObject`, whose `current` is readonly
// to the type system — but ChatView assigns them every render, and so does this
// test (it stands in for ChatView's per-render assignment).
type ScrollApi = {
  itemsRef: { current: { key: string; id?: number }[] };
  virtualizerRef: { current: { scrollToIndex: ReturnType<typeof vi.fn> } };
  virtualizerImplRef: { current: unknown };
  messagesContainerRef: { current: HTMLDivElement | null };
};

let api: ScrollApi;

function Harness() {
  const scroll = useTranscriptScroll({
    activeChatSessionId: "sess-1",
    hasMoreHistory: false,
    loadOlder: async () => undefined,
    messages: [],
    streaming: false,
    approvalKey: null,
    questionKey: null,
  });
  useEffect(() => {
    api = scroll as unknown as ScrollApi;
  }, [scroll]);
  return <div data-testid="transcript" ref={scroll.messagesContainerRef} />;
}

beforeEach(() => {
  // jsdom implements no scrolling — record the calls instead.
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  scrollToChatMessage(-1, null);
});

describe("turn rail jump", () => {
  it("drives a NATIVE smooth scroll to the row, not the virtualizer's", () => {
    render(<Harness />);
    const el = document.querySelector('[data-testid="transcript"]') as HTMLDivElement;
    const scrollToIndex = vi.fn();
    // Three rows; the target row starts at 300px down the list.
    api.itemsRef.current = [{ key: "a", id: 1 }, { key: "b", id: 2 }, { key: "c", id: 3 }];
    api.virtualizerRef.current = { scrollToIndex };
    api.virtualizerImplRef.current = {
      getMeasurements: () => [
        { start: 0 },
        { start: 300 },
        { start: 600 },
      ],
    };
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });

    scrollToChatMessage(2, "sess-1");

    // The regression: the inert smooth scrollToIndex must NOT be the mechanism.
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 300, behavior: "smooth" });
  });

  it("honours prefers-reduced-motion with an instant scroll", () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("prefers-reduced-motion"),
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      onchange: null,
    })) as unknown as typeof window.matchMedia;
    try {
      render(<Harness />);
      const el = document.querySelector('[data-testid="transcript"]') as HTMLDivElement;
      api.itemsRef.current = [{ key: "a", id: 1 }];
      api.virtualizerRef.current = { scrollToIndex: vi.fn() };
      api.virtualizerImplRef.current = {
        getMeasurements: () => [{ start: 120 }],
      };
      Object.defineProperty(el, "scrollHeight", { configurable: true, value: 2000 });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });

      scrollToChatMessage(1, "sess-1");

      expect(el.scrollTo).toHaveBeenCalledWith({ top: 120, behavior: "auto" });
    } finally {
      window.matchMedia = original;
    }
  });

  it("clamps the target to the real scroll range", () => {
    render(<Harness />);
    const el = document.querySelector('[data-testid="transcript"]') as HTMLDivElement;
    api.itemsRef.current = [{ key: "a", id: 1 }];
    api.virtualizerRef.current = { scrollToIndex: vi.fn() };
    // A stale measurement past the end must not scroll past the content.
    api.virtualizerImplRef.current = {
      getMeasurements: () => [{ start: 9999 }],
    };
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });

    scrollToChatMessage(1, "sess-1");

    expect(el.scrollTo).toHaveBeenCalledWith({ top: 700, behavior: "smooth" });
  });

  it("falls back to the instant virtualizer scroll with no measurements yet", () => {
    render(<Harness />);
    const el = document.querySelector('[data-testid="transcript"]') as HTMLDivElement;
    const scrollToIndex = vi.fn();
    api.itemsRef.current = [{ key: "a", id: 1 }];
    api.virtualizerRef.current = { scrollToIndex };
    // First paint: the virtualizer has no measurements to read an offset from.
    api.virtualizerImplRef.current = {};
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });

    scrollToChatMessage(1, "sess-1");

    expect(scrollToIndex).toHaveBeenCalledWith(0, { align: "start" });
    expect(el.scrollTo).not.toHaveBeenCalled();
  });

  it("ignores an unknown message id", () => {
    render(<Harness />);
    const el = document.querySelector('[data-testid="transcript"]') as HTMLDivElement;
    const scrollToIndex = vi.fn();
    api.itemsRef.current = [{ key: "a", id: 1 }];
    api.virtualizerRef.current = { scrollToIndex };
    api.virtualizerImplRef.current = { getMeasurements: () => [{ start: 0 }] };

    scrollToChatMessage(999, "sess-1");

    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(el.scrollTo).not.toHaveBeenCalled();
  });
});
