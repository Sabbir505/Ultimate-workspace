// ToolbarHeader — the portal that puts a full-page view's header chrome in
// the window title bar (components/common/ToolbarHeader).
//
// Two contracts matter, and they're opposites: with the shell's caption
// present the header must land in the slot, and with no shell at all (a unit
// test, a pop-out that has no caption) it must stay inline where it was —
// that's what keeps the view renderable on its own.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ToolbarHeader, TOOLBAR_SLOT_ID } from "../components/common/ToolbarHeader";

afterEach(() => {
  cleanup();
  document.getElementById(TOOLBAR_SLOT_ID)?.remove();
});

describe("ToolbarHeader", () => {
  it("stays inline when there is no title bar to portal into", () => {
    const { container } = render(
      <ToolbarHeader>
        <h1>Vault</h1>
      </ToolbarHeader>,
    );
    // Rendered in the view itself, not somewhere else in the document.
    expect(container.querySelector("h1")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Vault" })).toBeTruthy();
  });

  it("portals into the title-bar slot when the shell provides one", () => {
    const slot = document.createElement("div");
    slot.id = TOOLBAR_SLOT_ID;
    document.body.appendChild(slot);

    const { container } = render(
      <ToolbarHeader>
        <h1>Crew</h1>
      </ToolbarHeader>,
    );

    const heading = screen.getByRole("heading", { name: "Crew" });
    expect(slot.contains(heading)).toBe(true);
    // Gone from the view — the caption is now the only place it renders.
    expect(container.querySelector("h1")).toBeNull();
  });

  it("keeps the header's own content (controls included) intact in the slot", () => {
    const slot = document.createElement("div");
    slot.id = TOOLBAR_SLOT_ID;
    document.body.appendChild(slot);

    render(
      <ToolbarHeader>
        <h1>Automations</h1>
        <button title="Refresh">R</button>
      </ToolbarHeader>,
    );

    // Portalling is a DOM move, not a re-render: the title and the control
    // both survive it, so a header that owns state keeps working in place.
    expect(screen.getByRole("heading", { name: "Automations" })).toBeTruthy();
    expect(screen.getByTitle("Refresh")).toBeTruthy();
  });
});
