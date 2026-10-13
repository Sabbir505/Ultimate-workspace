// Tests for the PermissionModeMenu selector and the full_auto one-time
// confirmation flow. The menu must render all four postures, and selecting
// `full_auto` must NOT apply the mode on the first click — instead it opens
// the confirmation modal (the store intercepts the request). Selecting any
// other mode applies immediately.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
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
  // Open the popup and return a scoped query helper: the trigger label now
  // resolves through the same catalog as the items, so while the menu is
  // open both share text — menu assertions must scope to the popup. The
  // popup is PORTALED to <body> (the composer card's backdrop-filter traps
  // it under the docked question card otherwise), so query the document.
  const open = () => {
    fireEvent.click(result.getByTitle(TRIGGER));
    const popup = document.querySelector(".permission-mode-popup");
    if (!popup) throw new Error("popup did not open");
    return within(popup as HTMLElement);
  };
  return { ...result, open, onModeChange };
}

describe("PermissionModeMenu", () => {
  it("renders a trigger labelled with the active mode", () => {
    const { getByTitle } = renderMenu("manual");
    expect(getByTitle(TRIGGER).textContent).toContain("Manual");
  });

  it("lists all four modes when opened", () => {
    const { getByTitle, open } = renderMenu("manual");
    const menu = open();
    expect(menu.getByText("Read Only")).toBeTruthy();
    expect(menu.getByText("Manual Approval")).toBeTruthy();
    expect(menu.getByText("Auto-Edit")).toBeTruthy();
    expect(menu.getByText("Full Auto")).toBeTruthy();
  });

  it("applies a non-full_auto mode immediately on selection", () => {
    const { getByTitle, open, onModeChange } = renderMenu("manual");
    const menu = open();
    fireEvent.click(menu.getByText("Auto-Edit"));
    expect(onModeChange).toHaveBeenCalledWith("auto_edit");
  });

  it("also requests full_auto via onModeChange (store gates application)", () => {
    // The menu itself does NOT know about the one-time confirmation — it just
    // reports the user's selection to the store, which intercepts full_auto.
    const { getByTitle, open, onModeChange } = renderMenu("manual");
    const menu = open();
    fireEvent.click(menu.getByText("Full Auto"));
    expect(onModeChange).toHaveBeenCalledWith("full_auto");
  });
});

describe("PermissionModeMenu plan posture", () => {
  it("hides the Plan entry by default (opt-in via planAvailable)", () => {
    const { getByTitle } = render(
      <PermissionModeMenu mode="manual" onModeChange={() => {}} />,
    );
    fireEvent.click(getByTitle(TRIGGER));
    const popup = document.querySelector(".permission-mode-popup") as HTMLElement;
    expect(popup).toBeTruthy();
    expect(within(popup).queryByText("Plan")).toBeNull();
    expect(within(popup).getByText("Read Only")).toBeTruthy();
  });

  it("offers Plan when planAvailable and reports the selection", () => {
    const onModeChange = vi.fn();
    const { getByTitle } = render(
      <PermissionModeMenu mode="manual" onModeChange={onModeChange} planAvailable />,
    );
    fireEvent.click(getByTitle(TRIGGER));
    const popup = document.querySelector(".permission-mode-popup") as HTMLElement;
    fireEvent.click(within(popup).getByText("Plan"));
    expect(onModeChange).toHaveBeenCalledWith("plan");
  });

  it("labels an active plan session on the trigger", () => {
    const { getByTitle } = render(
      <PermissionModeMenu mode="plan" onModeChange={() => {}} planAvailable />,
    );
    expect(getByTitle(TRIGGER).textContent).toContain("Plan");
  });
});

// Regression (stacking): the popup used to render INSIDE the composer card,
// whose backdrop-filter makes the card a stacking context — so the docked
// question card (.plan-preview, a sibling ABOVE the card at z-index 1) painted
// straight over it. Opening the mode menu with a question pending buried the
// menu under the question. The popup must portal to <body> to escape the
// card's stacking context and float above the docked notch.
describe("PermissionModeMenu docked stacking", () => {
  it("portals the popup to <body>, outside the composer card", () => {
    const { getByTitle } = renderMenu("manual");
    fireEvent.click(getByTitle(TRIGGER));
    const popup = document.querySelector(".permission-mode-popup") as HTMLElement;
    expect(popup).toBeTruthy();
    // Body-level portal — no composer-card / question-notch ancestor.
    expect(popup.parentElement).toBe(document.body);
    expect(popup.closest(".chat-composer-card")).toBeNull();
    expect(popup.closest(".plan-preview")).toBeNull();
  });

  it("does not close when a mode row is clicked (portal-aware outside handler)", () => {
    const { getByTitle, open, onModeChange } = renderMenu("manual");
    const menu = open();
    fireEvent.pointerDown(menu.getByText("Auto-Edit"));
    // Still open after the pointerdown landed inside the portaled popup…
    expect(document.querySelector(".permission-mode-popup")).toBeTruthy();
    fireEvent.click(menu.getByText("Auto-Edit"));
    // …and the click selects the mode.
    expect(onModeChange).toHaveBeenCalledWith("auto_edit");
  });
});

describe("PermissionModeMenu harness catalog override", () => {
  it("lists ONLY the harness's own postures when modes is set", () => {
    const onModeChange = vi.fn();
    const { getByTitle } = render(
      <PermissionModeMenu
        mode="build"
        onModeChange={onModeChange}
        modes={[
          { value: "build", label: "Build", description: "Full agent — reads and writes." },
          { value: "plan", label: "Plan", description: "OpenCode's read-only planning mode." },
        ]}
      />
    );
    fireEvent.click(getByTitle(TRIGGER));
    const popup = document.querySelector(".permission-mode-popup") as HTMLElement;
    // Harness catalog replaces the built-in list wholesale.
    expect(within(popup).getByText("Build")).toBeTruthy();
    expect(within(popup).getByText("OpenCode's read-only planning mode.")).toBeTruthy();
    expect(within(popup).queryByText("Manual Approval")).toBeNull();
    expect(within(popup).queryByText("Full Auto")).toBeNull();
    fireEvent.click(within(popup).getByText("Plan"));
    expect(onModeChange).toHaveBeenCalledWith("plan");
  });

  it("labels an unknown-to-builtin harness mode via its catalog", () => {
    const { getByTitle } = render(
      <PermissionModeMenu
        mode="acceptEdits"
        onModeChange={() => {}}
        modes={[
          { value: "acceptEdits", label: "Accept Edits", description: "Edits auto-run." },
        ]}
      />,
    );
    expect(getByTitle(TRIGGER).textContent).toContain("Accept Edits");
  });
});
