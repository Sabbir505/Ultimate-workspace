// Local-model runtime tweaks (roadmap P0 §4.1):
//   1. LlamaAdvancedFields renders the full LM Studio-style field set and
//      patches edits through onChange (incl. the last-good indicator).
//   2. Picker integration: each local model row carries a gear that opens a
//      sub-modal with the full tweak set (incl. Context); the draft seeds
//      from the persisted overrides, "Load model" passes the merged draft,
//      and closing the sub-modal discards an unapplied draft.
//   3. LocalModelModal: shows for model-less installs with a VRAM hint,
//      deep-links to Settings → Local Models → market, hides once the
//      onboarded KV is set or models exist, and dismissal persists the KV.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// jsdom doesn't implement scrollIntoView (used by AgentModelPicker's
// keyboard-nav effect) — stub it like permissionModeMenu.test does.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const getSettingMock = vi.fn();
const setSettingMock = vi.fn();
const scanLocalModelsMock = vi.fn();
const getGpuVramMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    getSetting: (...a: unknown[]) => getSettingMock(...a),
    setSetting: (...a: unknown[]) => setSettingMock(...a),
    scanLocalModels: (...a: unknown[]) => scanLocalModelsMock(...a),
    getGpuVram: (...a: unknown[]) => getGpuVramMock(...a),
  };
});

import { AgentModelPicker } from "../components/chat/AgentModelPicker";
import { LlamaAdvancedFields } from "../components/chat/LlamaAdvancedFields";
import { LocalModelModal } from "../components/onboarding/LocalModelModal";
import { useUiStore } from "../state/ui";
import type { GgufModel, LlamaOverrides } from "../lib/ipc";

beforeEach(() => {
  vi.clearAllMocks();
  getSettingMock.mockResolvedValue(null);
  setSettingMock.mockResolvedValue(undefined);
  scanLocalModelsMock.mockResolvedValue([]);
  getGpuVramMock.mockResolvedValue(null);
  useUiStore.setState({ localModelsOpenMarket: false, settingsCategory: null, activeView: "chat" });
});

afterEach(() => cleanup());

describe("LlamaAdvancedFields", () => {
  it("renders the full tweak set and patches edits through onChange", () => {
    let value: LlamaOverrides | undefined;
    const { container } = render(
      <LlamaAdvancedFields overrides={{ ngl: 40 }} onChange={(v) => (value = v)} />,
    );
    const text = Array.from(container.querySelectorAll(".llama-field-label"))
      .map((l) => l.textContent)
      .join("|");
    for (const expected of [
      "GPU layers",
      "Context",
      "Flash Attention",
      "KV cache",
      "Threads",
      "Batch",
      "uBatch",
      "Parallel",
      "Seed",
      "Temp",
      "Top-p",
      "Top-k",
      "Min-p",
      "Repeat penalty",
      "Extra args",
      "No mmap",
    ]) {
      expect(text).toContain(expected);
    }

    // The first number input is GPU layers — editing patches the whole object.
    const gpuInput = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(gpuInput.value).toBe("40");
    fireEvent.change(gpuInput, { target: { value: "20" } });
    expect(value).toMatchObject({ ngl: 20 });

    // Clearing a field means auto (undefined).
    fireEvent.change(gpuInput, { target: { value: "" } });
    expect(value).toMatchObject({ ngl: undefined });
  });

  it("shows the auto-recorded last-good indicator and menu variant hides ctx", () => {
    const { container } = render(
      <LlamaAdvancedFields variant="menu" overrides={{ lastGoodNgl: 12 }} onChange={() => {}} />,
    );
    expect(container.textContent).toContain("Last good: 12 GPU layers");
    expect(container.textContent).not.toContain(">Context<");
  });
});

describe("AgentModelPicker per-model gear sub-modal", () => {
  const LOCAL_MODEL = {
    id: "gguf-1",
    path: "D:/m.gguf",
    filename: "my-model.gguf",
    name: "my-model",
    sizeBytes: 1,
    architecture: null,
    paramCountLabel: null,
    quantization: null,
    memoryClass: "fits",
    source: "folder",
    hasVision: false,
    mmprojPath: null,
  } as unknown as GgufModel;

  const openGear = async () => {
    // Only toggle the chip when the picker popup isn't already open (the
    // gear sub-modal closes independently of the picker).
    if (!document.querySelector(".agent-model-popup")) {
      fireEvent.click(document.querySelector<HTMLElement>(".agent-chip")!);
    }
    const gear = await screen.findByRole("button", {
      name: /advanced settings for my-model/i,
    });
    fireEvent.click(gear);
    await waitFor(() => {
      expect(document.querySelector(".agent-model-gear-modal")).not.toBeNull();
    });
    return document.querySelector<HTMLElement>(".agent-model-gear-modal")!;
  };

  const renderPicker = (persisted: LlamaOverrides, load: (m: string, o: LlamaOverrides) => void) =>
    render(
      <AgentModelPicker
        agent="local"
        model="my-model"
        provider="local_gguf"
        onPick={() => {}}
        localOverridesMap={{ "my-model": persisted }}
        onLoadLocalModel={load}
      />,
    );

  it("seeds the draft from persisted overrides; Load model passes the merged draft", async () => {
    scanLocalModelsMock.mockResolvedValue([LOCAL_MODEL]);
    const load = vi.fn();
    renderPicker({ flashAttn: true, lastGoodNgl: 30 }, load);

    const modal = await openGear();
    const loadBtn = modal.querySelector<HTMLButtonElement>(".model-effort-llama-apply")!;

    const gpuInput = modal.querySelector<HTMLInputElement>('input[type="number"]')!;
    // No ngl in the persisted entry → the field starts empty.
    expect(gpuInput.value).toBe("");
    fireEvent.change(gpuInput, { target: { value: "40" } });
    fireEvent.click(loadBtn);

    expect(load).toHaveBeenCalledWith("my-model", { flashAttn: true, lastGoodNgl: 30, ngl: 40 });
  });

  it("closing the sub-modal discards an unapplied draft", async () => {
    scanLocalModelsMock.mockResolvedValue([LOCAL_MODEL]);
    const load = vi.fn();
    renderPicker({ lastGoodNgl: 30 }, load);

    let modal = await openGear();
    const gpuInput = modal.querySelector<HTMLInputElement>('input[type="number"]')!;
    fireEvent.change(gpuInput, { target: { value: "40" } });

    // Close the sub-modal, then reopen — the draft must be gone.
    fireEvent.click(modal.querySelector<HTMLButtonElement>(".agent-model-gear-close")!);
    modal = await openGear();
    const gpuAfter = modal.querySelector<HTMLInputElement>('input[type="number"]')!;
    // Draft discarded on close — the field is empty again.
    expect(gpuAfter.value).toBe("");
    expect(load).not.toHaveBeenCalled();
  });

  it("shows no gear on cloud sessions", () => {
    scanLocalModelsMock.mockResolvedValue([LOCAL_MODEL]);
    render(
      <AgentModelPicker
        agent="builtin"
        model="gpt-x"
        provider="openai"
        onPick={() => {}}
        onLoadLocalModel={() => {}}
      />,
    );
    fireEvent.click(document.querySelector<HTMLElement>(".agent-chip")!);
    expect(screen.queryByTitle(/Advanced runtime settings/i)).toBeNull();
  });
});

describe("LocalModelModal (first-run onboarding)", () => {
  it("shows for model-less installs with a VRAM hint and deep-links to the market", async () => {
    scanLocalModelsMock.mockResolvedValue([]);
    getGpuVramMock.mockResolvedValue({ totalVramBytes: 8 * 1024 * 1024 * 1024, deviceName: "RTX" });
    render(<LocalModelModal />);

    expect(await screen.findByText(/Run models locally/i)).toBeTruthy();
    expect(screen.getByText(/8\.0 GB of VRAM/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Browse the Model Market" }));
    const ui = useUiStore.getState();
    expect(ui.settingsCategory).toBe("localmodels");
    expect(ui.localModelsOpenMarket).toBe(true);
    expect(ui.activeView).toBe("settings");
  });

  it("is hidden once the onboarded KV is set or a local model exists", async () => {
    getSettingMock.mockResolvedValue("1");
    const { unmount } = render(<LocalModelModal />);
    await waitFor(() => {
      expect(screen.queryByText(/Run models locally/i)).toBeNull();
    });
    unmount();

    getSettingMock.mockResolvedValue(null);
    scanLocalModelsMock.mockResolvedValue([{ id: "x" } as never]);
    render(<LocalModelModal />);
    await waitFor(() => {
      expect(screen.queryByText(/Run models locally/i)).toBeNull();
    });
  });

  it("dismiss persists the onboarded KV", async () => {
    render(<LocalModelModal />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() => {
      expect(setSettingMock).toHaveBeenCalledWith("localModels.onboarded", "1");
    });
  });
});
