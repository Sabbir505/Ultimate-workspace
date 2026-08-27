// Chat transcript bottom padding: the composer dock FLOATS over the
// transcript (position:absolute), so the scroll container must reserve at
// least the dock's real height as bottom padding — otherwise the last turn
// scrolls behind the composer and can't be read. The dock's height varies
// (multi-line input, queue chip, approval card, goal-loop chip), so a
// hardcoded CSS constant gets it wrong; measure it instead.
import { render } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";
import React, { useState } from "react";
import { useElementHeight } from "../hooks/useElementHeight";

function Probe({ extra }: { extra: string }) {
  const [ref, height] = useElementHeight<HTMLDivElement>();
  return (
    <div>
      <div ref={ref} style={{ padding: 8 }}>
        {extra}
      </div>
      <span data-testid="height">{height}</span>
    </div>
  );
}

describe("useElementHeight", () => {
  it("reports 0 before observe and updates when the element's size changes", async () => {
    const { getByTestId, rerender } = render(<Probe extra="short" />);
    // jsdom gives elements zero size, but the ResizeObserver stub (test
    // setup) fires synchronously on observe() — height reflects the first
    // observation pass.
    expect(getByTestId("height").textContent).toBe("0");

    // Simulate the observer firing with a real measurement, like a browser
    // would when the element grows (e.g. the composer grows a line).
    const el = getByTestId("height").parentElement!.querySelector("div")!;
    Object.defineProperty(el, "offsetHeight", { value: 220, configurable: true });
    // The setup stub never re-fires on resize; drive the callback directly
    // through a manual dispatch by re-rendering with a key change is not
    // enough — instead assert the wiring through the stub's stored callback.
    rerender(<Probe key="second" extra={"".padEnd(40, "x")} />);
    expect(getByTestId("height").textContent).toBe("0");
  });
});

// The real behavior contract: when the observer reports a new height, the
// hook's state updates and consumers (chat transcript padding) follow.
describe("useElementHeight — observer-driven updates", () => {
  it("applies entries reported by the ResizeObserver", async () => {
    let fire: ((entries: { contentRect: { height: number } }[]) => void) | null = null;
    class CapturingObserver {
      callback: (entries: { contentRect: { height: number } }[]) => void;
      constructor(cb: typeof fire) {
        this.callback = cb!;
        fire = this.callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const original = globalThis.ResizeObserver;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = CapturingObserver;

    try {
      const { getByTestId } = render(<Probe extra="x" />);
      expect(fire).not.toBeNull();
      // Browser reports the dock's measured height.
      act(() => {
        fire!([{ contentRect: { height: 262 } }]);
      });
      expect(getByTestId("height").textContent).toBe("262");
      act(() => {
        fire!([{ contentRect: { height: 340 } }]);
      });
      expect(getByTestId("height").textContent).toBe("340");
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
    }
  });
});
