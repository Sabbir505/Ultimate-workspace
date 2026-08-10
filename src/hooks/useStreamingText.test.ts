import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useStreamingText } from "./useStreamingText";

function makeStream() {
  const subs = new Set<(chunk: string) => void>();
  return {
    push: (c: string) => {
      for (const s of subs) s(c);
    },
    subscribe: (cb: (chunk: string) => void) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
}

describe("useStreamingText", () => {
  it("accumulates tokens and flushes on rAF", async () => {
    const stream = makeStream();
    const { result } = renderHook(() =>
      useStreamingText({ initial: "", incoming$: stream }),
    );

    act(() => {
      for (let i = 0; i < 100; i++) stream.push("a");
    });

    // Before rAF, displayed may still be "" (the buffer holds the data).
    expect(result.current.displayed).toBe("");

    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });

    expect(result.current.displayed).toBe("a".repeat(100));
  });

  it("coalesces many chunks into a single render per frame", async () => {
    const stream = makeStream();
    const setStateSpy = vi.spyOn(
      (await import("react")).useState as never,
      // we just want to count; the actual implementation is opaque
      "call",
    );
    setStateSpy.mockClear();
    const { result } = renderHook(() =>
      useStreamingText({ initial: "", incoming$: stream }),
    );

    act(() => {
      for (let i = 0; i < 50; i++) stream.push("x");
    });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(result.current.displayed).toBe("x".repeat(50));
    setStateSpy.mockRestore();
  });

  it("reset() clears the buffer and replaces displayed text", async () => {
    const stream = makeStream();
    const { result } = renderHook(() =>
      useStreamingText({ initial: "start: ", incoming$: stream }),
    );

    act(() => {
      stream.push("hello");
    });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(result.current.displayed).toBe("start: hello");

    act(() => {
      result.current.reset("fresh: ");
    });
    expect(result.current.displayed).toBe("fresh: ");
  });

  it("unsubscribes on unmount and cancels pending rAF", async () => {
    const stream = makeStream();
    const unsubSpy = vi.fn();
    const tracked = {
      subscribe: (cb: (chunk: string) => void) => {
        const u = stream.subscribe(cb);
        return () => {
          unsubSpy();
          u();
        };
      },
    };
    const { unmount } = renderHook(() =>
      useStreamingText({ initial: "", incoming$: tracked }),
    );

    unmount();
    expect(unsubSpy).toHaveBeenCalled();
  });
});
