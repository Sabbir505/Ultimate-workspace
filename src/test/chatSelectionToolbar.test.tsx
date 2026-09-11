// ChatSelectionToolbar behavior contract:
//  * appears ONLY after the selection gesture ends — never mid-drag
//    (selectionchange just re-hides / re-arms a short debounce)
//  * anchored ALWAYS above the selection top, horizontally centered,
//    with the anchor clamped so it can't leave the window
//  * selections outside chat/markdown hosts never summon it
//  * collapsing the selection hides it again
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSelectionToolbar } from "../components/chat/ChatSelectionToolbar";

vi.mock("../lib/chatSelection", () => ({
  sendChatSelectionAsFollowUp: vi.fn(),
}));

vi.mock("../state/chat", () => ({
  useChatStore: {
    getState: () => ({ focusedChatSessionId: null, activeChatSessionId: "s1" }),
  },
}));

// jsdom doesn't implement Range.getBoundingClientRect at all — the component
// treats a missing/zero rect as "no selection box", so provide a realistic
// one. `fakeRect` is mutable for per-test overrides.
let fakeRect: DOMRect;
Object.defineProperty(Range.prototype, "getBoundingClientRect", {
  configurable: true,
  value: function () {
    return fakeRect;
  },
});

// The component coalesces with rAF; run those callbacks on the fake clock.
vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) =>
  window.setTimeout(() => cb(performance.now()), 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));

function makeHost(): HTMLElement {
  const host = document.createElement("div");
  host.className = "chat-bubble-inner";
  host.textContent = "The quick brown fox jumps over the lazy dog.";
  document.body.appendChild(host);
  return host;
}

function selectInHost(host: HTMLElement, start: number, end: number): void {
  const textNode = host.firstChild!;
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Advance the fake clock AND flush the React state updates the timers fire. */
function settle(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function selectRange(start: number, end: number): void {
  act(() => {
    const host = document.querySelector<HTMLElement>(".chat-bubble-inner")!;
    const textNode = host.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

const toolbar = () => document.querySelector<HTMLElement>(".chat-selection-toolbar");

beforeEach(() => {
  vi.useFakeTimers();
  fakeRect = {
    x: 100, y: 200, left: 100, top: 200, right: 150, bottom: 220,
    width: 50, height: 20, toJSON: () => ({}),
  } as DOMRect;
});

afterEach(() => {
  cleanup();
  document.querySelectorAll(".chat-bubble-inner").forEach((el) => el.remove());
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe("ChatSelectionToolbar", () => {
  it("does not appear mid-drag — only after the selection quiet period", () => {
    render(<ChatSelectionToolbar />);
    makeHost();
    // Simulate a drag: successive selectionchange events with a live
    // selection. Each one re-arms the 250ms debounce — nothing shows.
    selectRange(4, 6);
    settle(100);
    selectRange(4, 10);
    settle(100);
    selectRange(4, 15);
    settle(100);
    expect(toolbar()).toBeNull();
    // Gesture settles → quiet period elapses → toolbar shows.
    settle(400);
    expect(toolbar()).not.toBeNull();
  });

  it("anchors above the selection, horizontally centered, clamped to the window", () => {
    render(<ChatSelectionToolbar />);
    makeHost();
    selectRange(4, 15);
    settle(400);
    const tb = toolbar()!;
    // gBCR stub: top 200 → anchor y stays 200 (well below the 46px floor).
    // Selection center x = 125 → within clamp margins.
    expect(tb.style.top).toBe("200px");
    expect(tb.style.left).toBe("125px");
    const r = tb.getBoundingClientRect();
    expect(r.bottom).toBeLessThanOrEqual(200);
  });

  it("clamps the anchor up when the selection sits at the very top of the window", () => {
    fakeRect = {
      x: 100, y: 10, left: 100, top: 10, right: 150, bottom: 30,
      width: 50, height: 20, toJSON: () => ({}),
    } as DOMRect;
    render(<ChatSelectionToolbar />);
    makeHost();
    selectRange(4, 15);
    settle(400);
    // Floor = TOOLBAR_H(32) + gap(8) + margin(6) = 46 → toolbar stays on-screen.
    expect(toolbar()!.style.top).toBe("46px");
  });

  it("ignores selections outside chat/markdown hosts", () => {
    render(<ChatSelectionToolbar />);
    const stranger = document.createElement("div");
    stranger.textContent = "not a chat bubble";
    document.body.appendChild(stranger);
    act(() => {
      const textNode = stranger.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 5);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    settle(400);
    expect(toolbar()).toBeNull();
    stranger.remove();
  });

  it("collapsing the selection hides a visible toolbar", () => {
    render(<ChatSelectionToolbar />);
    makeHost();
    selectRange(4, 15);
    settle(400);
    expect(toolbar()).not.toBeNull();
    act(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    settle(50);
    expect(toolbar()).toBeNull();
  });
});
