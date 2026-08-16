// Local-model runtime tweaks (roadmap P0 §4.1):
//   1. LlamaAdvancedFields renders the full LM Studio-style field set and
//      patches edits through onChange (incl. the last-good indicator).
//   2. Composer integration: the model menu's Advanced section seeds a draft
//      from the persisted overrides, Apply & reload passes the merged draft
//      (disabled while clean), and closing the menu discards an unapplied
//      draft.
//   3. LocalModelBanner: shows for model-less installs with a VRAM hint,
//      deep-links to Settings → Local Models → market, hides once the
//      onboarded KV is set or models exist, and dismissal persists the KV.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// jsdom doesn't implement scrollIntoView (used by ModelEffortMenu's
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

import { ModelEffortMenu } from "../components/chat/ModelEffortMenu";
import { LlamaAdvancedFields } from "../components/chat/LlamaAdvancedFields";
import { LocalModelBanner } from "../components/onboarding/LocalModelBanner";
import { useUiStore } from "../state/ui";
import type { LlamaOverrides } from "../lib/ipc";

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

describe("ModelEffortMenu inline Advanced runtime settings", () => {
  const openAdvanced = async () => {
    const trigger = document.querySelector<HTMLElement>(".model-effort-trigger")!;
    fireEvent.click(trigger);
    fireEvent.click(screen.getByText("Effort"));
    fireEvent.click(screen.getByText("⚙ Advanced runtime settings"));
    await waitFor(() => {
      expect(document.querySelector(".model-effort-llama")).not.toBeNull();
    });
    return document.querySelector<HTMLElement>(".model-effort-llama")!;
  };

  const renderMenu = (persisted: LlamaOverrides, apply: (o: LlamaOverrides) => Promise<void>) =>
    render(
      <ModelEffortMenu
        model="my-model"
        models={[]}
        localModels={["my-model"]}
        effort=""
        provider="local_gguf"
        activeLocal={{ id: "gguf-1", path: "D:/m.gguf", mmprojPath: null }}
        localOverrides={persisted}
        onApplyLocalOverrides={apply}
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />,
    );

  it("seeds the draft from persisted overrides; Apply & reload passes the merged draft", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    renderMenu({ flashAttn: true, lastGoodNgl: 30 }, apply);

    const adv = await openAdvanced();
    const applyBtn = adv.querySelector<HTMLButtonElement>(".model-effort-llama-apply")!;
    // Clean draft → Apply disabled.
    expect(applyBtn.disabled).toBe(true);

    const gpuInput = adv.querySelector<HTMLInputElement>('input[type="number"]')!;
    // No ngl in the persisted entry → the field starts empty.
    expect(gpuInput.value).toBe("");
    fireEvent.change(gpuInput, { target: { value: "40" } });
    expect(applyBtn.disabled).toBe(false);
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(apply).toHaveBeenCalledWith({ flashAttn: true, lastGoodNgl: 30, ngl: 40 });
    });
  });

  it("closing the menu discards an unapplied draft", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    renderMenu({ lastGoodNgl: 30 }, apply);

    let adv = await openAdvanced();
    const gpuInput = adv.querySelector<HTMLInputElement>('input[type="number"]')!;
    fireEvent.change(gpuInput, { target: { value: "40" } });

    // Close the whole menu, then reopen — the draft must be gone.
    fireEvent.click(document.querySelector<HTMLElement>(".model-effort-trigger")!);
    adv = await openAdvanced();
    const gpuAfter = adv.querySelector<HTMLInputElement>('input[type="number"]')!;
    // Draft discarded on close — the field is empty again.
    expect(gpuAfter.value).toBe("");
    expect(apply).not.toHaveBeenCalled();
  });

  it("hides the Advanced section for cloud providers or unresolved models", () => {
    render(
      <ModelEffortMenu
        model="gpt-x"
        models={["gpt-x"]}
        effort=""
        provider="openai"
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />,
    );
    fireEvent.click(document.querySelector<HTMLElement>(".model-effort-trigger")!);
    fireEvent.click(screen.getByText("Effort"));
    expect(document.querySelector(".model-effort-llama")).toBeNull();
  });
});

describe("LocalModelBanner (first-run onboarding)", () => {
  it("shows for model-less installs with a VRAM hint and deep-links to the market", async () => {
    scanLocalModelsMock.mockResolvedValue([]);
    getGpuVramMock.mockResolvedValue({ totalVramBytes: 8 * 1024 * 1024 * 1024, deviceName: "RTX" });
    render(<LocalModelBanner />);

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
    const { unmount } = render(<LocalModelBanner />);
    await waitFor(() => {
      expect(screen.queryByText(/Run models locally/i)).toBeNull();
    });
    unmount();

    getSettingMock.mockResolvedValue(null);
    scanLocalModelsMock.mockResolvedValue([{ id: "x" } as never]);
    render(<LocalModelBanner />);
    await waitFor(() => {
      expect(screen.queryByText(/Run models locally/i)).toBeNull();
    });
  });

  it("dismiss persists the onboarded KV", async () => {
    render(<LocalModelBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss notification" }));
    await waitFor(() => {
      expect(setSettingMock).toHaveBeenCalledWith("localModels.onboarded", "1");
    });
  });
});
