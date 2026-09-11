// Sidebar art tests: the header paints the art on a masked layer (feathered
// edge, no hard stop), the panel previews it miniaturized, the stock gallery
// selects presets, and the upload flow calls import → read → store update.
// IPC is stubbed; the dialog module is mocked at its dynamic-import site.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const importArtMock = vi.fn();
const readArtMock = vi.fn();
const clearArtMock = vi.fn();
const setPresetMock = vi.fn();
const getSettingMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const dialogOpenMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  importSidebarArt: (...a: unknown[]) => importArtMock(...a),
  readSidebarArtData: () => readArtMock(),
  clearSidebarArt: () => clearArtMock(),
  setSidebarArtPreset: (...a: unknown[]) => setPresetMock(...a),
  getSidebarArtPath: vi.fn().mockResolvedValue(null),
  getSetting: (...a: unknown[]) => getSettingMock(...a),
  SIDEBAR_ART_PRESETS: [
    { id: "aurora", label: "Aurora" },
    { id: "ember", label: "Ember" },
  ],
  sidebarArtPresetUrl: (id: string) => `/sideart/${id}.png`,
  toastError: (...a: unknown[]) => toastErrorMock(...a),
  toastSuccess: (...a: unknown[]) => toastSuccessMock(...a),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => dialogOpenMock(...a),
}));

import { SidebarHeader } from "../components/sidebar/Sidebar";
import { SidebarArtPanel } from "../components/settings/SidebarArtPanel";
import { useAppearanceStore } from "../state/appearance";

const DATA_URL = "data:image/png;base64,AAAA";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  readArtMock.mockResolvedValue(null);
  getSettingMock.mockResolvedValue(null);
  importArtMock.mockResolvedValue("C:\\data\\sidebar-art.png");
  clearArtMock.mockResolvedValue(undefined);
  setPresetMock.mockResolvedValue(undefined);
  useAppearanceStore.setState({ artData: null, artPreset: null, loaded: false });
});

describe("sidebar header art", () => {
  it("renders plain (no art layer, keeps the border) when unset", async () => {
    render(<SidebarHeader />);
    await waitFor(() => expect(useAppearanceStore.getState().loaded).toBe(true));
    const header = document.querySelector("[data-tauri-drag-region]");
    expect(header).toBeTruthy();
    expect(header!.className).not.toContain("sidebar-header-art");
    expect(header!.className).toContain("border-b");
    expect(document.querySelector(".sidebar-header-art-layer")).toBeNull();
  });

  it("paints the art on a masked layer and drops the border when set", async () => {
    useAppearanceStore.setState({ artData: DATA_URL, artPreset: null, loaded: true });
    render(<SidebarHeader />);
    const header = document.querySelector<HTMLElement>("[data-tauri-drag-region].sidebar-header-art");
    expect(header).toBeTruthy();
    // No hard bottom border — the feather replaces it.
    expect(header!.className).not.toContain("border-b");
    const layer = document.querySelector<HTMLElement>(".sidebar-header-art-layer");
    expect(layer).toBeTruthy();
    const style = layer!.getAttribute("style") || "";
    expect(style).toContain("linear-gradient"); // scrim over the art
    expect(style).toContain(DATA_URL);
  });

  it("resolves a stored preset to its bundle URL on refresh", async () => {
    getSettingMock.mockImplementation((key: string) =>
      Promise.resolve(key === "sidebar.artPreset" ? "aurora" : null),
    );
    useAppearanceStore.setState({ loaded: false });
    await useAppearanceStore.getState().refresh();
    expect(useAppearanceStore.getState().artData).toBe("/sideart/aurora.png");
    expect(useAppearanceStore.getState().artPreset).toBe("aurora");
  });

  it("prefers the custom upload's data URL when no preset is stored", async () => {
    getSettingMock.mockResolvedValue(null);
    readArtMock.mockResolvedValue(DATA_URL);
    useAppearanceStore.setState({ loaded: false });
    await useAppearanceStore.getState().refresh();
    expect(useAppearanceStore.getState().artData).toBe(DATA_URL);
    expect(useAppearanceStore.getState().artPreset).toBeNull();
  });
});

describe("SidebarArtPanel", () => {
  it("shows a mini header preview, the gallery, and upload when unset", () => {
    render(<SidebarArtPanel />);
    expect(document.querySelector(".sidebar-art-preview-header")).toBeTruthy();
    // One gallery thumbnail per stock preset.
    expect(document.querySelectorAll(".sidebar-art-thumb").length).toBe(2);
    expect(screen.getByText("Upload your own")).toBeTruthy();
    expect(screen.queryByText("Remove")).toBeNull();
  });

  it("marks the selected preset and picks a new one through the backend", async () => {
    useAppearanceStore.setState({ artData: "/sideart/aurora.png", artPreset: "aurora", loaded: true });
    render(<SidebarArtPanel />);
    // aurora selected (active), ember not.
    expect(document.querySelector(".sidebar-art-thumb.active")!.textContent).toContain("Aurora");
    fireEvent.click(screen.getByTitle("Use Ember"));
    await waitFor(() => expect(setPresetMock).toHaveBeenCalledWith("ember"));
    await waitFor(() =>
      expect(useAppearanceStore.getState().artData).toBe("/sideart/ember.png"),
    );
    expect(useAppearanceStore.getState().artPreset).toBe("ember");
  });

  it("uploads: dialog pick → import → read → store update", async () => {
    readArtMock.mockResolvedValue(DATA_URL);
    dialogOpenMock.mockResolvedValue("C:\\pics\\art.png");
    render(<SidebarArtPanel />);
    fireEvent.click(screen.getByText("Upload your own"));
    await waitFor(() => expect(importArtMock).toHaveBeenCalledWith("C:\\pics\\art.png"));
    await waitFor(() => expect(useAppearanceStore.getState().artData).toBe(DATA_URL));
    expect(useAppearanceStore.getState().artPreset).toBeNull();
    expect(toastSuccessMock).toHaveBeenCalledWith("Sidebar art updated");
    expect(screen.getByText("Remove")).toBeTruthy();
  });

  it("cancelling the dialog imports nothing", async () => {
    dialogOpenMock.mockResolvedValue(null);
    render(<SidebarArtPanel />);
    fireEvent.click(screen.getByText("Upload your own"));
    await waitFor(() => expect(dialogOpenMock).toHaveBeenCalled());
    expect(importArtMock).not.toHaveBeenCalled();
  });

  it("remove clears the store and the backend entry", async () => {
    useAppearanceStore.setState({ artData: DATA_URL, artPreset: null, loaded: true });
    render(<SidebarArtPanel />);
    fireEvent.click(screen.getByText("Remove"));
    await waitFor(() => expect(clearArtMock).toHaveBeenCalled());
    await waitFor(() => expect(useAppearanceStore.getState().artData).toBeNull());
    expect(toastSuccessMock).toHaveBeenCalledWith("Sidebar art removed");
  });

  it("surfaces import failures as toasts", async () => {
    importArtMock.mockRejectedValue(new Error("boom"));
    dialogOpenMock.mockResolvedValue("C:\\pics\\art.bmp");
    render(<SidebarArtPanel />);
    fireEvent.click(screen.getByText("Upload your own"));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(useAppearanceStore.getState().artData).toBeNull();
  });
});
