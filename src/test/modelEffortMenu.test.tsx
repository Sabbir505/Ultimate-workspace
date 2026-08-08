import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelEffortMenu } from "../components/chat/ModelEffortMenu";

// The eject button lets the user stop the running llama-server sidecar and
// free its VRAM. Visibility is gated on (provider === "local_gguf" &&
// localModelActive), and the click must NOT toggle the dropdown open.
//
// Note: the project doesn't register @testing-library/jest-dom, so we use
// plain DOM queries (toBeNull / toBeTruthy) instead of the custom matchers.

function getEject(): HTMLElement | null {
  return screen.queryByRole("button", { name: /eject model/i });
}

describe("ModelEffortMenu — eject local model", () => {
  it("renders the eject button when a local model is active", () => {
    render(
      <ModelEffortMenu
        model="Llama-3-8B-Instruct-Q4_K_M.gguf"
        models={[]}
        localModels={["Llama-3-8B-Instruct-Q4_K_M.gguf"]}
        effort=""
        provider="local_gguf"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        localModelActive
        onEjectLocalModel={() => {}}
      />,
    );
    expect(getEject()).toBeTruthy();
  });

  it("hides the eject button when the active provider is not local_gguf", () => {
    render(
      <ModelEffortMenu
        model="gpt-4o"
        models={["gpt-4o"]}
        localModels={["Llama-3-8B-Instruct-Q4_K_M.gguf"]}
        effort=""
        provider="openai"
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />,
    );
    expect(getEject()).toBeNull();
  });

  it("hides the eject button on a local_gguf session with no live sidecar", () => {
    render(
      <ModelEffortMenu
        model="Llama-3-8B-Instruct-Q4_K_M.gguf"
        models={[]}
        localModels={["Llama-3-8B-Instruct-Q4_K_M.gguf"]}
        effort=""
        provider="local_gguf"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        // localModelActive omitted → defaults to false
      />,
    );
    expect(getEject()).toBeNull();
  });

  it("calls onEjectLocalModel on click and does not open the dropdown", () => {
    const onEject = vi.fn();
    const { container } = render(
      <ModelEffortMenu
        model="Llama-3-8B-Instruct-Q4_K_M.gguf"
        models={[]}
        localModels={["Llama-3-8B-Instruct-Q4_K_M.gguf"]}
        effort=""
        provider="local_gguf"
        onModelChange={() => {}}
        onEffortChange={() => {}}
        localModelActive
        onEjectLocalModel={onEject}
      />,
    );
    const ejectBtn = getEject();
    expect(ejectBtn).toBeTruthy();
    fireEvent.click(ejectBtn!);
    expect(onEject).toHaveBeenCalledTimes(1);
    // Dropdown must remain closed — the click is stopPropagation'd.
    expect(container.querySelector(".model-effort-popup")).toBeNull();
  });

  it("hides the eject button while a local model is loading", () => {
    render(
      <ModelEffortMenu
        model="Llama-3-8B-Instruct-Q4_K_M.gguf"
        models={[]}
        localModels={["Llama-3-8B-Instruct-Q4_K_M.gguf"]}
        effort=""
        provider="local_gguf"
        modelLoading
        onModelChange={() => {}}
        onEffortChange={() => {}}
        localModelActive
        onEjectLocalModel={() => {}}
      />,
    );
    // While loading the trigger shows the spinner instead of the eject icon.
    expect(getEject()).toBeNull();
  });
});
