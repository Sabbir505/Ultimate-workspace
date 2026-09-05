// Auto mode (Phase 1 of auto model routing): the picker gains an "Auto" rail
// entry — its own section, always first — whose pane commits the session to
// backend-resolved provider+model routing (provider "auto", model "auto").
// The chip shows "Auto" for auto-routed sessions, including after a send has
// written the resolved provider/model back (ChatView passes provider "auto"
// whenever session.autoModel).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

import { AgentModelPicker } from "../components/chat/AgentModelPicker";

const openPicker = (container: HTMLElement) => {
  fireEvent.click(container.querySelector<HTMLElement>(".agent-chip")!);
};

function renderPicker(props: Partial<Parameters<typeof AgentModelPicker>[0]> = {}) {
  const view = render(
    <AgentModelPicker
      agent="builtin"
      model="gpt-4o"
      provider="openai"
      onPick={() => {}}
      {...props}
    />,
  );
  openPicker(view.container);
  return view;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("AgentModelPicker — Auto routing entry", () => {
  it("lists Auto first in the rail with its own section", () => {
    const { container } = renderPicker();
    const sections = container.querySelectorAll(".agent-model-rail-section");
    expect(sections.length).toBeGreaterThan(1);
    const first = sections[0]!.querySelector("button");
    expect(first?.getAttribute("aria-label")).toBe("Auto");
  });

  it("highlights the Auto entry when the session is auto-routed", () => {
    const { container } = renderPicker({ provider: "auto", model: "auto" });
    const autoBtn = container.querySelector(
      '.agent-model-rail button[aria-label="Auto"]',
    );
    expect(autoBtn?.classList.contains("rail-selected")).toBe(true);
    // The chip itself reads "Auto".
    expect(container.querySelector(".agent-chip-label")?.textContent).toBe("Auto");
  });

  it("commits provider auto + model auto straight from the rail click", () => {
    const onPick = vi.fn();
    const { container } = renderPicker({ onPick });
    // No pane row to click — the rail icon itself commits.
    fireEvent.click(
      container.querySelector<HTMLElement>('.agent-model-rail button[aria-label="Auto"]')!,
    );
    expect(onPick).toHaveBeenCalledWith({
      agent: "builtin",
      provider: "auto",
      model: "auto",
    });
  });

  it("shows centered info (not a clickable row) when the session is auto-routed", () => {
    const onPick = vi.fn();
    const { container } = renderPicker({ provider: "auto", model: "auto", onPick });
    const info = container.querySelector(".agent-model-auto-info");
    expect(info).toBeTruthy();
    expect(info?.textContent).toContain("Auto — Relay picks");
    // Re-clicking the rail does NOT re-commit (it just opens the pane).
    fireEvent.click(
      container.querySelector<HTMLElement>('.agent-model-rail button[aria-label="Auto"]')!,
    );
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("AgentModelPicker — Auto bias slider", () => {
  it("renders the bias slider in the Auto pane with Balanced as the default", () => {
    const { container } = renderPicker({ provider: "auto", model: "auto", onAutoBiasChange: () => {} });
    const rail = screen.getByRole("slider", { name: "Auto routing bias" });
    expect(rail.getAttribute("aria-valuetext")).toBe("Balanced");
    const labels = [...container.querySelectorAll<HTMLElement>(".seg-slider-label")];
    expect(labels.map((l) => l.textContent)).toEqual(["Economy", "Balanced", "Quality"]);
  });

  it("reflects the persisted bias and reports changes via the keyboard", () => {
    const onAutoBiasChange = vi.fn();
    renderPicker({
      provider: "auto",
      model: "auto",
      autoBias: "economy",
      onAutoBiasChange,
    });
    const rail = screen.getByRole("slider", { name: "Auto routing bias" });
    expect(rail.getAttribute("aria-valuetext")).toBe("Economy");
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    expect(onAutoBiasChange).toHaveBeenCalledWith("balanced");
  });

  it("hides the bias slider outside the Auto pane", () => {
    renderPicker({ onAutoBiasChange: () => {} });
    expect(screen.queryByRole("slider", { name: "Auto routing bias" })).toBeNull();
  });
});
