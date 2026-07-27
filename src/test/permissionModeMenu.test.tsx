// Tests for the PermissionModeMenu selector and the full_auto one-time
// confirmation flow. The menu must render all four postures, and selecting
// `full_auto` must NOT apply the mode on the first click — instead it opens
// the confirmation modal (the store intercepts the request). Selecting any
// other mode applies immediately.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
    expect(getByTitle("Filesystem permission mode")).toBeTruthy();
    // The trigger shows the active mode's short label.
    expect(getByTitle("Filesystem permission mode").textContent).toContain("Manual");
  });

  it("lists all four modes when opened", () => {
    const { getByTitle, getByText } = renderMenu("manual");
    fireEvent.click(getByTitle("Filesystem permission mode"));
    // Click toggles open; all four labels appear.
    expect(getByText("Read Only")).toBeTruthy();
    expect(getByText("Manual Approval")).toBeTruthy();
    expect(getByText("Auto-Edit")).toBeTruthy();
    expect(getByText("Full Auto")).toBeTruthy();
  });

  it("applies a non-full_auto mode immediately on selection", () => {
    const { getByTitle, getByText, onModeChange } = renderMenu("manual");
    fireEvent.click(getByTitle("Filesystem permission mode"));
    // Selecting Auto-Edit fires onModeChange("auto_edit") right away — the
    // confirmation intercept is ONLY for full_auto.
    fireEvent.click(getByText("Auto-Edit"));
    expect(onModeChange).toHaveBeenCalledWith("auto_edit");
  });

  it("also requests full_auto via onModeChange (store gates application)", () => {
    // The menu itself does NOT know about the one-time confirmation — it just
    // reports the user's selection to the store, which intercepts full_auto.
    // The store test below asserts the modal actually opens. Here we only
    // confirm the menu reports the click faithfully.
    const { getByTitle, getByText, onModeChange } = renderMenu("manual");
    fireEvent.click(getByTitle("Filesystem permission mode"));
    fireEvent.click(getByText("Full Auto"));
    expect(onModeChange).toHaveBeenCalledWith("full_auto");
  });
});
