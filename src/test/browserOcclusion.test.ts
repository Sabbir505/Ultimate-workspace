import { describe, expect, it } from "vitest";
import { browserOccluded } from "../lib/browserOcclusion";

const clear = {
  activeView: "chat" as const,
  paletteOpen: false,
  peekOpen: false,
  modalOpen: false,
  paneVisible: true,
  collapsed: false,
};

describe("browserOccluded", () => {
  it("is not occluded in the main chat layout with the pane visible", () => {
    expect(browserOccluded(clear)).toBe(false);
  });

  it("is occluded by every overlay view", () => {
    for (const activeView of ["settings", "skills", "cost"] as const) {
      expect(browserOccluded({ ...clear, activeView })).toBe(true);
    }
  });

  it("is occluded by the command palette, peek panel, and modals", () => {
    expect(browserOccluded({ ...clear, paletteOpen: true })).toBe(true);
    expect(browserOccluded({ ...clear, peekOpen: true })).toBe(true);
    expect(browserOccluded({ ...clear, modalOpen: true })).toBe(true);
  });

  it("is occluded when the pane is hidden in split mode", () => {
    expect(browserOccluded({ ...clear, paneVisible: false })).toBe(true);
  });

  it("is occluded when the browser pane is collapsed (minimized)", () => {
    expect(browserOccluded({ ...clear, collapsed: true })).toBe(true);
    // Even if it's the visible split slot, a collapsed pane hides its webview.
    expect(browserOccluded({ ...clear, collapsed: true, paneVisible: true })).toBe(true);
  });

  it("is occluded while an HTML overlay (context meter tooltip) is showing", () => {
    // Native webviews float above all DOM — the tooltip can only win by
    // hiding the webview for its duration.
    expect(browserOccluded({ ...clear, htmlOverlayOpen: true })).toBe(true);
    expect(browserOccluded({ ...clear, htmlOverlayOpen: false })).toBe(false);
    // Absent input (legacy callers) behaves as false.
    expect(browserOccluded(clear)).toBe(false);
  });

  it("stays occluded until every condition clears", () => {
    const occluded = { ...clear, paletteOpen: true, paneVisible: false };
    expect(browserOccluded(occluded)).toBe(true);
    expect(browserOccluded({ ...occluded, paletteOpen: false })).toBe(true);
    expect(browserOccluded({ ...occluded, paletteOpen: false, paneVisible: true })).toBe(false);
  });
});
