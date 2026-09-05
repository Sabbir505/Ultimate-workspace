import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ContextMeter } from "../components/chat/ContextMeter";

// The context meter's hover panel: the model row must mirror the picker chip
// (a session with no agent picked shows "—", never the provider's seeded
// default, which reads as the previous chat's model), and the portaled panel
// must clamp against its MEASURED box so a meter near the window edge can't
// paint past the window border (the OS clips fixed-position content at the
// window edge, cutting the values column off).
//
// Note: no chatSessionId is passed, so the lazy breakdown fetch is skipped —
// no Tauri IPC mock needed.

const hover = (container: HTMLElement) =>
  fireEvent.mouseEnter(container.querySelector<HTMLElement>(".context-meter-circle")!);

const panel = () =>
  document.querySelector<HTMLElement>(".context-meter-panel");

const panelModelText = () =>
  document.querySelector<HTMLElement>(".context-meter-panel-model")?.textContent ?? null;

describe("ContextMeter — hover panel model row", () => {
  afterEach(cleanup);

  it("shows a dash when no model is committed (empty string)", () => {
    const view = render(
      <ContextMeter usedTokens={0} model="" provider="openai" isLocal={false} />,
    );
    hover(view.container);
    expect(panelModelText()).toBe("Model: —");
  });

  it("shows a dash when the model prop is undefined", () => {
    const view = render(
      <ContextMeter usedTokens={0} model={undefined} provider="openai" isLocal={false} />,
    );
    hover(view.container);
    expect(panelModelText()).toBe("Model: —");
  });

  it("shows the committed model name", () => {
    const view = render(
      <ContextMeter usedTokens={0} model="glm-5.2" provider="openai" isLocal={false} />,
    );
    hover(view.container);
    expect(panelModelText()).toBe("Model: glm-5.2");
  });
});

describe("ContextMeter — panel stays inside the viewport", () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  let originalOffsetWidth: PropertyDescriptor | undefined;
  let originalOffsetHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalOffsetWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetWidth",
    );
    originalOffsetHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    // jsdom reports 0 for every box; give the panel its real CSS footprint
    // (260px width + padding + border ≈ 286, tall enough to exercise the
    // vertical clamp) so the measured clamp has something to work with.
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get: () => 286,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 200,
    });
  });

  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth!);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight!);
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    cleanup();
  });

  it("re-clamps a right-edge meter so the panel fits inside the window", () => {
    // Narrow window; the meter circle sits at the far right (as in the bug
    // report: the panel ran past the window edge and was clipped). The clamp
    // uses the PANEL_WIDTH constant (260 → half 130), not a measured width.
    const originalInner = window.innerWidth;
    window.innerWidth = 400;
    HTMLElement.prototype.getBoundingClientRect = function () {
      // Only the meter circle's rect matters; everything else gets zeros.
      return {
        left: 372,
        top: 700,
        width: 28,
        height: 28,
        right: 400,
        bottom: 728,
        x: 372,
        y: 700,
        toJSON: () => {},
      } as DOMRect;
    };
    try {
      const view = render(
        <ContextMeter usedTokens={0} model="glm-5.2" provider="openai" isLocal={false} />,
      );
      hover(view.container);
      // The panel sits ENTIRELY to the left of the meter: left edge =
      // circle center (386) − half (130) − 100 − 8 = 148 — but this 400px
      // window is too narrow for that, so the right-bound clamp wins:
      // left = 400 − 260 − 8 = 132 (right edge back on the 8px margin).
      const left = parseFloat(panel()!.style.left);
      expect(left).toBe(132);
      expect(left + 260).toBeLessThanOrEqual(400);
    } finally {
      window.innerWidth = originalInner;
    }
  });

  it("keeps a tall panel's top on-screen on short windows", () => {
    const originalInner = window.innerHeight;
    window.innerHeight = 300;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return {
        left: 100,
        top: 250,
        width: 28,
        height: 28,
        right: 128,
        bottom: 278,
        x: 100,
        y: 250,
        toJSON: () => {},
      } as DOMRect;
    };
    try {
      const view = render(
        <ContextMeter usedTokens={0} model="glm-5.2" provider="openai" isLocal={false} />,
      );
      hover(view.container);
      // Initial bottom = 300 - 250 + 6 = 56 → panel top at 300-56-200 = 44.
      // With a taller panel (200) on a short window the clamp is
      // max(300-200-8, 8) = 92 … the initial 56 is BELOW that, so unchanged.
      // Force the overflow case instead: meter at the very top.
      cleanup();
      HTMLElement.prototype.getBoundingClientRect = function () {
        return {
          left: 100,
          top: 10,
          width: 28,
          height: 28,
          right: 128,
          bottom: 38,
          x: 100,
          y: 10,
          toJSON: () => {},
        } as DOMRect;
      };
      const view2 = render(
        <ContextMeter usedTokens={0} model="glm-5.2" provider="openai" isLocal={false} />,
      );
      hover(view2.container);
      // Initial bottom = 300 - 10 + 6 = 296 → top would be 300-296-200 = -196
      // (off-screen). Clamped to max(300-200-8, 8) = 92 → top = 8.
      const bottom = parseFloat(panel()!.style.bottom);
      expect(bottom).toBeLessThanOrEqual(92);
      expect(300 - bottom - 200).toBeGreaterThanOrEqual(0);
    } finally {
      window.innerHeight = originalInner;
    }
  });
});
