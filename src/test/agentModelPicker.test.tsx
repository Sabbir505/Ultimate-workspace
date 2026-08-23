import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// jsdom doesn't implement scrollIntoView (used by the picker's keyboard-nav
// effect) — stub it like the other menu tests do.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

import { AgentModelPicker } from "../components/chat/AgentModelPicker";

// The Local pane's eject row lets the user stop the running llama-server
// sidecar and free its VRAM. Visibility is gated on the session itself being
// local (agent "local" + provider local_gguf) AND a live sidecar.
//
// Note: the project doesn't register @testing-library/jest-dom, so we use
// plain DOM queries (toBeNull / toBeTruthy) instead of the custom matchers.

const getEject = (): HTMLElement | null =>
  screen.queryByRole("button", { name: /eject model/i });

const openPicker = (container: HTMLElement) => {
  fireEvent.click(container.querySelector<HTMLElement>(".agent-chip")!);
};

function renderPicker(props: Partial<Parameters<typeof AgentModelPicker>[0]> = {}) {
  const view = render(
    <AgentModelPicker
      agent="local"
      model="Llama-3-8B-Instruct-Q4_K_M.gguf"
      provider="local_gguf"
      onPick={() => {}}
      localModelActive
      onEjectLocalModel={() => {}}
      {...props}
    />,
  );
  openPicker(view.container);
  return view;
}

describe("AgentModelPicker — local model eject", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("renders the eject row in the Local pane when a local model is active", () => {
    renderPicker();
    expect(getEject()).toBeTruthy();
  });

  it("hides the eject row when the session is not local", () => {
    renderPicker({ agent: "builtin", model: "gpt-4o", provider: "openai" });
    expect(getEject()).toBeNull();
  });

  it("hides the eject row on a local session with no live sidecar", () => {
    // localModelActive omitted → defaults to false
    renderPicker({ localModelActive: undefined, onEjectLocalModel: undefined });
    expect(getEject()).toBeNull();
  });

  it("calls onEjectLocalModel on click", () => {
    const onEject = vi.fn();
    renderPicker({ onEjectLocalModel: onEject });
    const btn = getEject();
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    expect(onEject).toHaveBeenCalledTimes(1);
  });

  it("shows a spinner on the chip while a harness/local model loads", () => {
    const { container } = renderPicker({ loading: true });
    expect(container.querySelector(".agent-chip-spinner")).toBeTruthy();
  });
});
