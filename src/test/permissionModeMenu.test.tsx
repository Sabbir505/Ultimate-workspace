// Tests for the PermissionModeMenu selector and the full_auto one-time
// confirmation flow. The menu must render all four postures, and selecting
// `full_auto` must NOT apply the mode on the first click — instead it opens
// the confirmation modal (the store intercepts the request). Selecting any
// other mode applies immediately.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PermissionModeMenu } from "../components/chat/PermissionModeMenu";

// jsdom doesn't implement scrollIntoView (used by the menu's keyboard-nav
// effect). Stub a no-op so the effect doesn't throw.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TRIGGER = "Approval mode (files + connected accounts)";

function renderMenu(initial: "manual" | "read_only" | "auto_edit" | "full_auto" = "manual") {
  const onModeChange = vi.fn();
  const result = render(
    <PermissionModeMenu mode={initial} onModeChange={onModeChange} />,
  );
  return { ...result, onModeChange };
}

describe("PermissionModeMenu", () => {
  it("renders a trigger labelled with the active mode", () => {
    const { getByTitle } = renderMenu("manual");
    expect(getByTitle(TRIGGER).textContent).toContain("Manual");
  });

  it("lists all four modes when opened", () => {
    const { getByTitle, getByText } = renderMenu("manual");
    fireEvent.click(getByTitle(TRIGGER));
    expect(getByText("Read Only")).toBeTruthy();
    expect(getByText("Manual Approval")).toBeTruthy();
    expect(getByText("Auto-Edit")).toBeTruthy();
    expect(getByText("Full Auto")).toBeTruthy();
  });

  it("applies a non-full_auto mode immediately on selection", () => {
    const { getByTitle, getByText, onModeChange } = renderMenu("manual");
    fireEvent.click(getByTitle(TRIGGER));
    fireEvent.click(getByText("Auto-Edit"));
    expect(onModeChange).toHaveBeenCalledWith("auto_edit");
  });

  it("also requests full_auto via onModeChange (store gates application)", () => {
    // The menu itself does NOT know about the one-time confirmation — it just
    // reports the user's selection to the store, which intercepts full_auto.
    const { getByTitle, getByText, onModeChange } = renderMenu("manual");
    fireEvent.click(getByTitle(TRIGGER));
    fireEvent.click(getByText("Full Auto"));
    expect(onModeChange).toHaveBeenCalledWith("full_auto");
  });
});
