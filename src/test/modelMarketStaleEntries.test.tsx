// C5 (ISSUES.md): two coupled defects around ModelMarket's download-progress
// listener.
//   1. The handler read `entries` from the effect closure, which only re-ran
//      when onDownloadComplete changed — with a stable callback the closure
//      kept the MOUNT-time snapshot ([]) and the auto-mmproj lookup after a
//      vision download never found the card. Now it reads entriesRef.
//   2. The parent (LocalModelsPanel) passed a fresh inline arrow as
//      onDownloadComplete on every render, re-subscribing the progress
//      listener per render. Now it's useCallback-stabilized.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const onProgressMock = vi.fn();
const downloadMmprojMock = vi.fn();
const fetchCatalogMock = vi.fn();
const scanLocalModelsMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scanLocalModels: (...a: unknown[]) => scanLocalModelsMock(...(a as [])),
  localModelStatus: vi.fn(async () => null),
  getLlamaServerPath: vi.fn(async () => null),
  getLocalModelOverrides: vi.fn(async () => null),
  getSetting: vi.fn(async () => ""),
  setSetting: vi.fn(async () => undefined),
  onModelDownloadProgress: (h: unknown) => onProgressMock(h),
  downloadMmproj: (...a: unknown[]) => downloadMmprojMock(...(a as [])),
  fetchModelCatalog: (...a: unknown[]) => fetchCatalogMock(...(a as [])),
  getMarketSettings: vi.fn(async () => null),
  getGpuVram: vi.fn(async () => null),
}));

import { ModelMarket } from "../components/settings/ModelMarket";
import { SettingsView } from "../components/settings/SettingsView";
import { useUiStore } from "../state/ui";
import type { CatalogEntry } from "../lib/ipc";

const VISION_ENTRY: CatalogEntry = {
  id: "author/vision::vis-q4.gguf",
  displayName: "vision",
  author: "author",
  repoId: "author/vision",
  filename: "vis-q4.gguf",
  downloads: 10,
  likes: 1,
  lastModified: null,
  sizeBytes: 2 * 1024 * 1024 * 1024,
  description: null,
  tags: [],
  sha256: null,
  downloadUrl: "https://example/v",
  vision: true,
  paramsLabel: null,
  quantization: "Q4_K_M",
  license: null,
  gated: false,
};

/** Capture the progress handler ModelMarket subscribes with. */
function captureProgressHandler() {
  const handlers: Array<(p: any) => void> = [];
  onProgressMock.mockImplementation(async (h: (p: any) => void) => {
    handlers.push(h);
    return () => {};
  });
  return () => handlers[handlers.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  scanLocalModelsMock.mockResolvedValue([]);
  downloadMmprojMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ activeView: "chat", settingsCategory: null, localModelsOpenMarket: false });
});

describe("ModelMarket auto-mmproj after vision download (C5)", () => {
  it("finds the finished card even though entries loaded after mount", async () => {
    const getLatestHandler = captureProgressHandler();
    fetchCatalogMock.mockResolvedValue({
      stale: false,
      hasHuggingFaceToken: false,
      entries: [VISION_ENTRY],
    });
    const onDownloadComplete = vi.fn();
    render(<ModelMarket onDownloadComplete={onDownloadComplete} />);

    // Catalog arrives AFTER the progress subscription was created.
    await waitFor(() => expect(screen_has_vision_card()).toBe(true));

    // The main .gguf download finishes.
    const handler = getLatestHandler();
    expect(handler).toBeTruthy();
    act(() => {
      handler!({
        id: VISION_ENTRY.id,
        state: "done",
        downloadedBytes: 10,
        totalBytes: 10,
        bytesPerSecond: 5,
        finalPath: "D:/m/vis-q4.gguf",
        error: null,
      });
    });

    // The mmproj auto-download must trigger for the vision card.
    expect(onDownloadComplete).toHaveBeenCalled();
    expect(downloadMmprojMock).toHaveBeenCalledWith("author/vision");
  });

  function screen_has_vision_card(): boolean {
    return !!document.querySelector(".model-market-grid")?.textContent?.includes("vision");
  }
});

describe("LocalModelsPanel keeps one progress subscription (C5)", () => {
  it("does not resubscribe onModelDownloadProgress when the parent re-renders", async () => {
    captureProgressHandler();
    useUiStore.setState({ activeView: "settings", settingsCategory: "localmodels" });
    const { rerender } = render(<SettingsView />);

    // Open the market tab (LocalModelsPanel consumes the deep-link flag).
    await act(async () => {
      useUiStore.setState({ localModelsOpenMarket: true });
    });
    await waitFor(() => expect(onProgressMock).toHaveBeenCalled());

    // Parent re-renders (the consuming effect flips the flag back off, plus
    // an explicit rerender) — the subscription must stay single.
    const initial = onProgressMock.mock.calls.length;
    expect(initial).toBeGreaterThanOrEqual(1);
    await act(async () => {
      useUiStore.setState({ localModelsOpenMarket: true });
    });
    rerender(<SettingsView />);
    await act(async () => {});
    expect(onProgressMock.mock.calls.length).toBe(initial);
  });
});
