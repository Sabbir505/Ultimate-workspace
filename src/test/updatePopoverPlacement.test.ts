// Update popover placement (UpdateButton's computePopoverPos).
//
// The details card used to be anchored to the button's LEFT edge. The button
// is a small pill in the top-LEFT sidebar header, so the card sat hard against
// the screen's left side and straddled the sidebar boundary with a long
// overhang — the "not properly positioned on the left side" report. It is now
// anchored to the button's right edge, flipped above when it can't fit below,
// and clamped inside the viewport on both axes.
import { describe, expect, it } from "vitest";
import { computePopoverPos } from "../components/sidebar/UpdateButton";

/** The real button rect in the 236px sidebar header at 1280×800. */
const BUTTON = { left: 115, right: 188, top: 2, bottom: 26 };
const CARD = { w: 300, h: 490 };
const WIDE = { w: 1280, h: 800 };
/** 100vh - 16px: the CSS max-height cap. */
const CAP = 520;

describe("computePopoverPos", () => {
  it("anchors the card to the button's RIGHT edge, not its left", () => {
    const { left } = computePopoverPos(BUTTON, CARD, WIDE);
    expect(left).toBe(BUTTON.right);
    // The reported bug: the card used to start at the button's LEFT edge,
    // flush against the left of the screen.
    expect(left).not.toBe(BUTTON.left);
  });

  it("drops below the button when there is room", () => {
    const { top } = computePopoverPos(BUTTON, CARD, WIDE);
    expect(top).toBe(BUTTON.bottom + 6);
  });

  it("flips above the button when the card is taller than the space below", () => {
    // Same card, but a button with room above it (a scrolled/short sidebar
    // can put it anywhere) — the card opens upward instead of off the bottom.
    const anchor = { left: 115, right: 188, top: 300, bottom: 324 };
    const viewport = { w: 1280, h: 480 };
    const capped = { w: CARD.w, h: Math.min(CAP, viewport.h - 16) };
    const { top } = computePopoverPos(anchor, capped, viewport);
    expect(top).toBeLessThan(anchor.top);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + capped.h).toBeLessThanOrEqual(viewport.h - 8);
  });

  it("keeps the card on screen when the button is flush against the top", () => {
    // The real sidebar header: the button sits 2px from the window top, so
    // there is NO room above it and "flip" can only mean flush to the top
    // edge. What matters is that the card still fits and never runs off the
    // bottom — the bug this replaced.
    const short = { w: 1280, h: 480 };
    const capped = { w: CARD.w, h: Math.min(CAP, short.h - 16) };
    const { top } = computePopoverPos(BUTTON, capped, short);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + capped.h).toBeLessThanOrEqual(short.h - 8);
  });

  it("never crosses a viewport edge, in either direction", () => {
    // Narrow window: the right-edge anchor doesn't fit, so the card slides
    // left rather than off-screen.
    const narrow = { w: 420, h: 700 };
    const { left, top } = computePopoverPos(BUTTON, CARD, narrow);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + CARD.w).toBeLessThanOrEqual(narrow.w - 8);
    expect(top + Math.min(CAP, CARD.h)).toBeLessThanOrEqual(narrow.h);
  });

  it("assumes the CSS width before the card has rendered, then defers the flip", () => {
    // First pass: no measured card yet — the width falls back to the CSS value
    // and the height is unknown, so it opens below…
    const first = computePopoverPos(BUTTON, null, { w: 1280, h: 800 });
    expect(first.left).toBe(BUTTON.right);
    expect(first.top).toBe(BUTTON.bottom + 6);
    // …and the measured second pass corrects a window too short to fit it.
    const anchor = { left: 115, right: 188, top: 300, bottom: 324 };
    const second = computePopoverPos(
      anchor,
      { w: CARD.w, h: Math.min(CAP, 480 - 16) },
      { w: 1280, h: 480 },
    );
    expect(second.top).toBeLessThan(anchor.top);
  });
});
